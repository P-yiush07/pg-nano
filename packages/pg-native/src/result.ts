import type Libpq from '@pg-nano/libpq'
import { snakeToCamel } from './casing.js'
import { getTypeParser } from './pg-types/textParsers.js'

export class Result<TRow extends Row = Row> {
  constructor(
    readonly command: string,
    readonly rowCount: number,
    readonly fields: Field[],
    readonly rows: TRow[],
  ) {}
}

export type Row = Record<string, unknown>

export interface Field {
  name: string
  dataTypeID: number
}

export enum FieldCase {
  preserve = 0,
  camel = 1,
}

const emptyArray = Object.freeze([]) as never[]
const getEmptyResult = memoize((command: string) =>
  Object.freeze(new Result(command, 0, emptyArray, emptyArray)),
)

export function buildResult(pq: Libpq, fieldCase: FieldCase) {
  const command = consumeCommand(pq)
  const rowCount = consumeRowCount(pq)

  let result: Result
  if (rowCount > 0) {
    const fields = consumeFields(pq, fieldCase)
    const rows = consumeRows(pq, fields)

    result = new Result(command, rowCount, fields, rows)
  } else {
    result = getEmptyResult(command)
  }

  pq.clear()
  return result
}

function consumeCommand(pq: Libpq) {
  return pq.cmdStatus().split(' ')[0]
}

function consumeRowCount(pq: Libpq) {
  const cmdTuples = pq.cmdTuples()
  return cmdTuples ? Number.parseInt(cmdTuples, 10) : 0
}

function consumeFields(pq: Libpq, fieldCase: FieldCase) {
  const fields = new Array(pq.nfields())
  for (let i = 0; i < fields.length; i++) {
    const name = pq.fname(i)
    fields[i] = {
      name: fieldCase === FieldCase.camel ? snakeToCamel(name) : name,
      dataTypeID: pq.ftype(i),
    }
  }
  return fields
}

function consumeRows(pq: Libpq, fields: Field[]) {
  const rows = new Array(pq.ntuples())
  for (let i = 0; i < rows.length; i++) {
    rows[i] = consumeRow(pq, i, fields)
  }
  return rows
}

function consumeRow(pq: Libpq, tupleNo: number, fields: Field[]) {
  const row: Record<string, unknown> = {}
  for (let fieldNo = 0; fieldNo < fields.length; fieldNo++) {
    row[fields[fieldNo].name] = consumeValue(pq, tupleNo, fieldNo, fields)
  }
  return row
}

function consumeValue(
  pq: Libpq,
  tupleNo: number,
  fieldNo: number,
  fields: Field[],
) {
  const rawValue = pq.getvalue(tupleNo, fieldNo)
  if (rawValue === '' && pq.getisnull(tupleNo, fieldNo)) {
    return null
  }
  const parseValue = getTypeParser(fields[fieldNo].dataTypeID)
  return parseValue(rawValue)
}

function memoize<T>(fn: (arg: string) => T): (arg: string) => T {
  const cache: Record<string, T> = {}
  return (arg: string) => (cache[arg] ||= fn(arg))
}
