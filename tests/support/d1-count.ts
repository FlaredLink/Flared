// SPDX-License-Identifier: AGPL-3.0-only
// Counts each statement a request runs, one for each statement in a batch, as D1 may count them
// against an invocation's query limit.
export function counting(db: D1Database, counter: { queries: number }): D1Database {
	const originals = new WeakMap<object, D1PreparedStatement>();
	const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
		const proxy = new Proxy(statement, {
			get(target, property) {
				if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
				const value: unknown = Reflect.get(target, property, target);
				if (typeof value !== 'function') return value;
				return (...args: unknown[]) => {
					if (['first', 'all', 'run', 'raw'].includes(String(property))) counter.queries += 1;
					return value.apply(target, args);
				};
			}
		});
		originals.set(proxy, statement);
		return proxy;
	};
	return new Proxy(db, {
		get(target, property) {
			if (property === 'prepare') return (query: string) => wrap(target.prepare(query));
			if (property === 'batch')
				return (statements: D1PreparedStatement[]) => {
					counter.queries += statements.length;
					return target.batch(statements.map((item) => originals.get(item) ?? item));
				};
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}
