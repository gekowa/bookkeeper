import type { ResourceProvider } from '../../src/providers/types.js'

export function fakeProvider(opts: Partial<ResourceProvider> & { kind: string }): ResourceProvider {
  return {
    plan: () => ({}), probe: async () => true, provision: async () => {},
    destroy: async () => {}, ...opts,
  }
}
