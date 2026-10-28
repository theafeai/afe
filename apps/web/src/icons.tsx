import type { ReactNode } from "react";

/** 16px line icons for the app shell. Decorative: always aria-hidden. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const icons = {
  environments: (
    <Icon>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M6.5 6.5v7" />
    </Icon>
  ),
  events: (
    <Icon>
      <path d="M1.75 8h2.5l1.75-4.5 3.5 9L11.25 8h3" />
    </Icon>
  ),
  deployments: (
    <Icon>
      <path d="M8 13.5V3M4 6.75 8 2.75l4 4M3 13.5h10" />
    </Icon>
  ),
  drift: (
    <Icon>
      <circle cx="4" cy="4" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <path d="M4 5.75v2.5A2.75 2.75 0 0 0 6.75 11H10M12 10.25v-2.5A2.75 2.75 0 0 0 9.25 5H6" />
    </Icon>
  ),
  connections: (
    <Icon>
      <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0V5ZM8 11v3" />
    </Icon>
  ),
  mapping: (
    <Icon>
      <rect x="1.75" y="2" width="4.5" height="3.5" rx="1" />
      <rect x="9.75" y="2" width="4.5" height="3.5" rx="1" />
      <rect x="5.75" y="10.5" width="4.5" height="3.5" rx="1" />
      <path d="M4 5.5v1.75c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V5.5M8 8.25v2.25" />
    </Icon>
  ),
  profile: (
    <Icon>
      <circle cx="8" cy="5.5" r="2.75" />
      <path d="M2.75 14a5.25 5.25 0 0 1 10.5 0" />
    </Icon>
  ),
  users: (
    <Icon>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.5 13.5a4.5 4.5 0 0 1 9 0M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12.5 9.6a4.5 4.5 0 0 1 2 3.9" />
    </Icon>
  ),
  signOut: (
    <Icon>
      <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11 13.5 8l-3-3M13.25 8H6" />
    </Icon>
  ),
  menu: (
    <Icon>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Icon>
  ),
};

/**
 * The Afe mark: three stages joined by a path (commit → artifact → live),
 * on an indigo tile.
 */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="6" fill="var(--accent-solid)" />
      <path
        d="M6 16.5 12 7.5l6 9"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.55"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="16.5" r="2" fill="#fff" fillOpacity="0.8" />
      <circle cx="12" cy="7.5" r="2" fill="#fff" fillOpacity="0.9" />
      <circle cx="18" cy="16.5" r="2.4" fill="#fff" />
    </svg>
  );
}
