import { describe, expect, it } from 'vitest'
import { applyTenantScope, CrossTenantWriteError } from '../src/index.js'

// FA-070 / D5: Prisma serialises any object argument by its enumerable keys
// (`for…in`), class instances included. The scoper only recognised PLAIN
// objects, so a DTO passed as `data` or as a nested where escaped the checks:
// an update could move the row to another tenant, a nested connect ran
// unscoped, and a create dropped every field but the tenant.

class ProjectDto {
  constructor(
    public name: string,
    public tenantId?: string,
  ) {}
}
class WhereById {
  constructor(public id: string) {}
}

describe('tenant scoping of class-instance (DTO) arguments (FA-070/D5)', () => {
  it('update: a DTO that sets another tenant is refused', () => {
    expect(() =>
      applyTenantScope('update', { where: { id: 'p1' }, data: new ProjectDto('x', 'globex') }, 'acme', 'tenantId'),
    ).toThrowError(CrossTenantWriteError)
  })

  it('upsert: the update branch DTO is checked too', () => {
    expect(() =>
      applyTenantScope(
        'upsert',
        { where: { id: 'p1' }, create: { name: 'x' }, update: new ProjectDto('x', 'globex') },
        'acme',
        'tenantId',
      ),
    ).toThrowError(CrossTenantWriteError)
  })

  it('create: a DTO keeps its fields and is stamped with the tenant', () => {
    expect(applyTenantScope('create', { data: new ProjectDto('Apollo') }, 'acme', 'tenantId')).toEqual({
      data: { name: 'Apollo', tenantId: 'acme' },
    })
  })

  it('create: a DTO cannot choose its own tenant', () => {
    expect(applyTenantScope('create', { data: new ProjectDto('Apollo', 'globex') }, 'acme', 'tenantId')).toEqual({
      data: { name: 'Apollo', tenantId: 'acme' },
    })
  })

  it('nested connect with a DTO where-unique is narrowed to the tenant', () => {
    const scoped = applyTenantScope(
      'update',
      { where: { id: 't1' }, data: { project: { connect: new WhereById('p-of-globex') } } },
      'acme',
      'tenantId',
    )
    expect(scoped['data']).toEqual({ project: { connect: { id: 'p-of-globex', tenantId: 'acme' } } })
  })

  it('a DTO holding a relation write has its nested create stamped', () => {
    class Nested {
      create = new ProjectDto('child', 'globex')
    }
    const scoped = applyTenantScope('update', { where: { id: 't1' }, data: { project: new Nested() } }, 'acme', 'tenantId')
    expect(scoped['data']).toEqual({ project: { create: { name: 'child', tenantId: 'acme' } } })
  })

  it('leaves Date / Buffer values alone', () => {
    const at = new Date(0)
    const bytes = Buffer.from('x')
    expect(applyTenantScope('update', { where: { id: 't1' }, data: { at, bytes } }, 'acme', 'tenantId')['data']).toEqual({
      at,
      bytes,
    })
  })
})
