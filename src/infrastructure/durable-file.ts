import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The durable-write primitives shared by every artifact publisher.
 *
 * These lived privately inside the activation module while the transitional
 * publisher grew a weaker second copy: fixed `.publishing` staging names that
 * two concurrent generations would clobber, a non-exclusive open, and a restore
 * path that wrote over the live file instead of staging and renaming. Two
 * implementations of one durability contract means the weaker one decides what
 * actually happens on disk, so there is now only one.
 */

/**
 * A staging path no concurrent publisher can also choose.
 *
 * pid separates processes, the timestamp separates sequential runs inside one
 * process, and the random suffix separates concurrent runs inside one process.
 * Creation is still exclusive, so a collision fails loudly rather than letting
 * one publisher rename another's bytes into place.
 */
export function temporaryPath(outputDir: string, label: string): string {
  return join(
    outputDir,
    `.madar-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  )
}

/**
 * Creates a new staging file exclusively, writes it, and flushes it.
 *
 * `wx` fails when the path already exists, which is what makes a staging-name
 * collision an error instead of silent data loss. The write and the flush go
 * through one writable handle: reopening read-only to fsync is portable on
 * POSIX but fails on Windows, where FlushFileBuffers requires write access.
 */
export function writeDurableTemporaryFile(path: string, bytes: Uint8Array | string): void {
  const descriptor = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Flushes the directory entry so a completed rename survives a crash.
 *
 * A POSIX guarantee, kept fail-closed there: a directory that cannot be
 * flushed means the rename is not durable, and the caller must hear about it.
 * Windows exposes no directory-flush API at all -- a directory cannot even be
 * opened as a file -- so the call is skipped there. Swallowing the error on
 * every platform would delete a real guarantee to quiet one platform.
 */
export function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}
