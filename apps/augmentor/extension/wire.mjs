// Augmentor — dsh-augmentor plugin, pipe, and Chromium extension
// Copyright © 2026 Manolo Remiddi
// SPDX-License-Identifier: MIT
// License: MIT — see LICENSE at the repository root.

/* Augmentor — shared wire primitives (F5, audit).
 *
 * One implementation of the JSON-frame vocabulary the three runtimes speak:
 *   - pipe.mjs           (Node ESM, repo root)
 *   - plugin/src/index.ts (imported, bundled into dist/index.js at build)
 *   - extension/sw.js     (MV3 module service worker)
 *
 * The extension is a standalone package that cannot reach outside its
 * directory, so extension/wire.mjs is a BYTE-IDENTICAL copy of this file;
 * the sw-e2e harness asserts the identity on every boot. Keep them in sync
 * by copying this file, never by editing the copy.
 *
 * Frame vocabulary (all JSON objects, one per message):
 *   request  { id, method, params }   client → server (either direction)
 *   reply    { id, result }           answer to a request, same id
 *   reply    { id, error: {message} } failed request
 *   welcome  { type:'welcome', name, protocol, version }  plugin → pipe, once
 *
 * Ids are opaque strings; each side generates its own with genId(prefix).
 * (The pipe passes the DSH app's rpcIds through unchanged for the app
 * downlink, where the id originates upstream.)
 */

export function encode(obj) {
  return JSON.stringify(obj)
}

/** JSON.parse with a null result on bad input (callers already trace it). */
export function decode(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** Monotonic id factory: prefix + 1-based counter. */
export function genId(prefix) {
  let n = 0
  return () => `${prefix}${++n}`
}

/**
 * In-flight request table with optional per-request timeout.
 *
 * Entries may carry an arbitrary `bind` (e.g. the socket the request went
 * out on): replies must be checked against it, and a disconnected socket
 * drops exactly its own entries (dropWhere) so an unreturned request can
 * never hang the panel — nor can one browser's drop settle another's.
 */
export class Pending {
  #map = new Map() // id -> { resolve, reject, timer, bind }

  get size() {
    return this.#map.size
  }

  has(id) {
    return this.#map.has(id)
  }

  /** The stored entry (for bind checks) or undefined. */
  get(id) {
    return this.#map.get(id)
  }

  /**
   * Register an in-flight request. Returns [resolve, reject] for the
   * caller's promise plumbing. `timeoutMs` settles the entry as a
   * rejection after the deadline (cleared on settle).
   */
  add(id, { bind = null, timeoutMs = 0 } = {}) {
    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const e = this.#map.get(id)
        if (!e) return
        this.#map.delete(id)
        e.reject(new Error(`timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref() // never hold the process open (Node); no-op elsewhere
    }
    let resolve, reject
    const handle = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    this.#map.set(id, { resolve, reject, timer, bind, promise: handle })
    return handle
  }

  /** Settle one entry. Returns false when the id was unknown (late reply). */
  settle(id, result, error) {
    const e = this.#map.get(id)
    if (!e) return false
    this.#map.delete(id)
    if (e.timer) clearTimeout(e.timer)
    if (error) e.reject(error instanceof Error ? error : new Error(String(error)))
    else e.resolve(result)
    return true
  }

  /** Reject every entry where pred(entry) is true (e.g. socket closed). */
  dropWhere(pred, error = new Error('disconnected')) {
    for (const [id, e] of [...this.#map]) {
      if (!pred(e)) continue
      this.#map.delete(id)
      if (e.timer) clearTimeout(e.timer)
      e.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Reject everything (port/socket closed with no per-entry routing). */
  dropAll(error = new Error('disconnected')) {
    this.dropWhere(() => true, error)
  }
}
