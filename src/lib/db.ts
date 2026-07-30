import Dexie, { type EntityTable } from 'dexie'
import type { Project, VersionHistory } from '@/types'

/**
 * WeDraw Database
 * Using Dexie.js for IndexedDB management
 */
class WeDrawDB extends Dexie {
  projects!: EntityTable<Project, 'id'>
  versionHistory!: EntityTable<VersionHistory, 'id'>

  constructor() {
    super('WeDrawDB')

    this.version(1).stores({
      // Primary key: id, indexed fields: title, engineType, createdAt, updatedAt
      projects: 'id, title, engineType, createdAt, updatedAt',
      // Primary key: id, indexed fields: projectId, timestamp
      versionHistory: 'id, projectId, timestamp',
    })
  }
}

// Singleton database instance
export const db = new WeDrawDB()
