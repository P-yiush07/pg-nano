import { type Client, isPgResultError, sql } from 'pg-nano'
import { debug } from './debug.js'
import type { SQLIdentifier } from './identifier'
import type {
  PgCompositeTypeStmt,
  PgRoutineStmt,
  PgViewStmt,
} from './parseObjectStatements.js'
import { appendCodeFrame } from './util/codeFrame.js'

/**
 * Compare a type to an existing type in the database.
 *
 * @returns `true` if the type has changed, `false` otherwise.
 */
export async function hasCompositeTypeChanged(
  client: Client,
  type: PgCompositeTypeStmt,
) {
  const tmpId = type.id.withSchema('nano')
  const tmpStmt = type.query.replace(
    type.id.toRegExp(),
    tmpId.toQualifiedName(),
  )

  // Add the latest type to the database (but under the "nano" schema), so we
  // can compare it to the existing type.
  await client.query(sql`
    DROP TYPE IF EXISTS ${tmpId.toSQL()} CASCADE;
    ${sql.unsafe(tmpStmt)}
  `)

  const selectTypeById = (id: SQLIdentifier) => sql`
    SELECT
      array_agg(
        (a.attname, a.atttypid, a.attnum)
        ORDER BY a.attnum
      ) AS columns
    FROM
      pg_type t
    JOIN
      pg_attribute a ON a.attrelid = t.typrelid
    WHERE
      t.typname = ${id.nameVal}
      AND t.typnamespace = ${id.schemaVal}::regnamespace
      AND t.typtype = 'c'
      AND a.attnum > 0
      AND NOT a.attisdropped
  `

  if (debug.enabled) {
    debug('did %s change?', type.id.toQualifiedName())
  }

  const hasChanges = await client.queryValue<boolean>(sql`
    WITH type1 AS (
      ${selectTypeById(type.id)}
    ),
    type2 AS (
      ${selectTypeById(tmpId)}
    )
    SELECT
      t1.columns <> t2.columns AS has_changes
    FROM
      type1 t1,
      type2 t2;
  `)

  return hasChanges
}

/**
 * Compare a routine to an existing routine in the database.
 *
 * @returns `true` if the routine has changed, `false` otherwise.
 */
export async function hasRoutineSignatureChanged(
  client: Client,
  fn: PgRoutineStmt,
) {
  const tmpId = fn.id.withSchema('nano')
  const tmpStmt = fn.query.replace(fn.id.toRegExp(), tmpId.toQualifiedName())

  // Add the latest routine to the database (but under the "nano" schema), so we
  // can compare it to the existing routine.
  await client
    .query(sql`
      DROP ROUTINE IF EXISTS ${tmpId.toSQL()} CASCADE;
      ${sql.unsafe(tmpStmt)}
    `)
    .catch(error => {
      if (isPgResultError(error) && error.statementPosition) {
        appendCodeFrame(
          error,
          +error.statementPosition,
          error.ddl,
          fn.line - 2,
          fn.file,
        )
      }
      throw error
    })

  const selectRoutineById = (id: SQLIdentifier) => sql`
    SELECT
      coalesce(p.proargnames, '{}') AS argument_names,
      coalesce(p.proargmodes, '{}') AS argument_modes,
      p.proargtypes::oid[] AS argument_types,
      p.prorettype AS return_type,
      p.provariadic AS variadic_type,
      p.prokind AS function_kind
    FROM
      pg_proc p
    WHERE
      p.proname = ${id.nameVal}
      AND p.pronamespace = ${id.schemaVal}::regnamespace
  `

  if (debug.enabled) {
    debug('did %s change?', fn.id.toQualifiedName())
  }

  const hasChanges = await client.queryValue<boolean>(sql`
    WITH routine1 AS (
      ${selectRoutineById(fn.id)}
    ),
    routine2 AS (
      ${selectRoutineById(tmpId)}
    )
    SELECT
      r1.argument_names <> r2.argument_names OR
      r1.argument_types <> r2.argument_types OR
      r1.argument_modes <> r2.argument_modes OR
      r1.return_type <> r2.return_type OR
      r1.variadic_type <> r2.variadic_type OR
      r1.function_kind <> r2.function_kind AS has_changes
    FROM
      routine1 r1,
      routine2 r2;
  `)

  return hasChanges
}

/**
 * Checks if a view has changed by comparing the existing view with a temporary
 * version created in the "nano" schema.
 *
 * @returns `true` if the view has changed, `false` otherwise.
 */
export async function hasViewChanged(client: Client, view: PgViewStmt) {
  const tmpId = view.id.withSchema('nano')
  const tmpStmt = view.query.replace(
    view.id.toRegExp(),
    tmpId.toQualifiedName(),
  )

  // Create a temporary version of the view in the "nano" schema
  await client.query(sql`
    DROP VIEW IF EXISTS ${tmpId.toSQL()} CASCADE;
    ${sql.unsafe(tmpStmt)}
  `)

  const selectViewDefinition = (id: SQLIdentifier) => sql`
    SELECT pg_get_viewdef(${id.toSQL()}::regclass) AS view_definition
  `

  const hasChanges = await client.queryValue<boolean>(sql`
    WITH view1 AS (
      ${selectViewDefinition(view.id)}
    ),
    view2 AS (
      ${selectViewDefinition(tmpId)}
    )
    SELECT
      v1.view_definition <> v2.view_definition AS has_changes
    FROM
      view1 v1,
      view2 v2;
  `)

  return hasChanges
}
