// SPDX-License-Identifier: AGPL-3.0-only
// Test schema generated from the pinned library, independent of the Drizzle mapping.
import { writeFileSync } from 'node:fs';
import { getAuthTables } from 'better-auth/db';
import { emailOTP, magicLink } from 'better-auth/plugins';
const tables = getAuthTables({
	plugins: [
		emailOTP({ sendVerificationOTP: async () => {} }),
		magicLink({ sendMagicLink: async () => {} })
	],
	rateLimit: { enabled: false }
});
const statements: string[] = [];
for (const [model, table] of Object.entries(tables)) {
	const columns = ['"id" TEXT PRIMARY KEY NOT NULL'];
	for (const [key, field] of Object.entries(table.fields)) {
		const name = field.fieldName ?? key;
		let column = `"${name}" ${field.type === 'date' || field.type === 'boolean' || field.type === 'number' ? 'INTEGER' : 'TEXT'}`;
		if (field.required) column += ' NOT NULL';
		if (field.unique) column += ' UNIQUE';
		if (field.references)
			column += ` REFERENCES "${field.references.model}"("${field.references.field}") ON DELETE CASCADE`;
		columns.push(column);
		if (field.index)
			statements.push(`CREATE INDEX "${model}_${name}_idx" ON "${model}"("${name}");`);
	}
	statements.unshift(`CREATE TABLE "${table.modelName}" (${columns.join(', ')});`);
}
writeFileSync(
	'tests/schema.sql',
	'-- SPDX-License-Identifier: AGPL-3.0-only\n' + statements.join('\n') + '\n'
);
