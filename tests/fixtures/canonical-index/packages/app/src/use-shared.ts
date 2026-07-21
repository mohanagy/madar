import type { SharedModel } from '@shared/model'

export function sharedId(model: SharedModel): string {
  return model.id
}
