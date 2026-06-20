export type DevBadge = {
  id: string;
  label: string;
  description: string;
  icon: string;
};

export type DevReputation = {
  level: number;
  title: string;
  score: number;
  nextLevelScore: number;
  stats: {
    totalVerifiedPushes: number;
    totalTokensLockedWei: string;
    totalTokensLockedFormatted: string;
    activeLocks: number;
    completedLocks: number;
    totalRepos: number;
    milestonesPaid: number;
    avgRating: number | null;
    reviewCount: number;
    firstLockAt: string | null;
    lastPushAt: string | null;
  };
  scoreBreakdown: {
    shipping: number;
    commitment: number;
    community: number;
  };
  badges: DevBadge[];
  earnedBadgeIds: string[];
};
