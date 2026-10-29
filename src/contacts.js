import { config } from './config.js';
import { contactTier } from './memory.js';

// What each tier of contact is allowed to do. Everyone starts as a stranger, the owner included:
// the tier is her relationship with someone, and she moves people between tiers herself as she gets
// to know them (see relationships.js). The owner (OWNER_IDS, plus the dashboard) keeps admin rights
// on top of whatever tier they're in, and can still set anyone's tier by telling her to.
export const TIERS = {
  // Strangers are remembered too: getting to know someone needs memory of them.
  stranger: { remember: true, search: false, files: false, sendElsewhere: false, persona: false },
  guest: { remember: true, search: true, files: true, sendElsewhere: false, persona: false },
  friend: { remember: true, search: true, files: true, sendElsewhere: true, persona: true },
};

export function isOwner(userId) {
  return userId === 'dashboard' || config.ownerIds.includes(userId);
}

// Her relationship with someone: 'friend' | 'guest' | 'stranger' (the owner too; the dashboard is
// always treated as a friend, since it isn't a person she's getting to know).
export function tierOf(userId) {
  return userId === 'dashboard' ? 'friend' : contactTier(userId);
}

// What she'll do for someone. The owner gets everything (admin rights) whatever their tier.
export function permissions(userId) {
  const tier = tierOf(userId);
  if (isOwner(userId)) return { ...TIERS.friend, tier, owner: true };
  return { ...(TIERS[tier] ?? TIERS.stranger), tier, owner: false };
}
