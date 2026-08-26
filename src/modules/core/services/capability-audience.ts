/**
 * Which groups a capability is open to, on top of the ordinary on/off switch.
 *
 * Deliberately not part of `@kernhq/kernel`'s capability system: that system's own contract states
 * the rule this would break — "a capability is about a workspace, a permission is about a person" —
 * and a capability whose *visibility* varies per person is a person-shaped question wearing a
 * capability-shaped name. So this lives here, as a second, narrower reserved key on the same
 * settings blob `$capabilities` already occupies, read only at the two places that need it (the MCP
 * endpoint, personal API keys) rather than folded into `kernel.capabilities()` for every module.
 *
 * A capability with no entry here — the default, and the only state before this shipped — is open to
 * every member the ordinary switch already lets in. Restricting it does not touch the switch itself:
 * a workspace that turns `mcp` off is still off for everyone regardless of this key, and a member
 * outside the allowed groups sees exactly what an off capability already shows everyone — 404, never
 * a permission error that would confirm the feature exists.
 */
export const CAPABILITY_AUDIENCE_KEY = '$capabilityAudience'

export type CapabilityAudience = Record<string, string[] | null>

/** `null` or an absent entry means "everyone the capability switch already admits". */
export function audienceAllows(
  stored: unknown,
  capabilityId: string,
  memberGroupIds: readonly string[],
): boolean {
  const audience = (stored as CapabilityAudience | undefined)?.[capabilityId]
  if (!audience || audience.length === 0) return true
  return audience.some((g) => memberGroupIds.includes(g))
}
