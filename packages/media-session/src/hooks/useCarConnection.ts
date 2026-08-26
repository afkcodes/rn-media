import { useSyncExternalStore } from 'react'

import { MediaService } from '../media-service'
import type { CarConnection } from '../types'

/**
 * Whether a car is driving this session, and which kind — re-rendering on every
 * transition.
 *
 * ```tsx
 * const car = useCarConnection()
 * if (car.kind !== 'none') return <DrivingModeScreen />
 * ```
 *
 * The reactive twin of `MediaServiceApi.getCarConnection()`. Safe to call
 * before `MediaService.init` — it reads `{ kind: 'none' }` until a session
 * exists, then updates itself — and safe to keep mounted across a
 * `stopService()`, because the subscription belongs to the component rather
 * than to the session.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the value is owned
 * by native, and this is the hook React provides for exactly that. The store's
 * snapshot is a stable object (see `createMediaService`'s `carConnection`), so
 * this cannot loop.
 *
 * The server snapshot is the same function: there is no server, and React only
 * asks for it under `renderToString`, where "no car" is the only answer that
 * could be right.
 */
export function useCarConnection(): CarConnection {
  return useSyncExternalStore(
    MediaService.subscribeCarConnection,
    MediaService.getCarConnection,
    MediaService.getCarConnection
  )
}
