/**
 * Agent Toolkits — centralized integration branding catalog.
 * Spec: docs/superpowers/specs/2026-07-10-agent-toolkits-integrations-design.md
 *
 * Shared is pure TS (no React, no platform imports), so this catalog is DATA:
 * raw SVG markup strings + display metadata. Renderers stay per-app (RN
 * `SvgXml` on mobile, inline/`<img>` on web) — this module never renders
 * anything itself.
 *
 * `logoSvg` values are the OFFICIAL brand marks. jira/slack are the
 * multicolor originals (from the vendor). Every other entry (the 6 live
 * integrations' single-path marks + the whole COMING SOON set) is a
 * simple-icons single-path mark that ships with a black fill by default —
 * that fill has been rewritten here to #FFFFFF so the mark reads on the
 * dark surfaces this catalog targets; consumers may re-tint via
 * `brandColor` (e.g. an SVG `<mask>`/currentColor wrapper) if a different
 * treatment is needed. `pendo` + `amplitude` are NOT in simple-icons
 * (brand-guideline restrictions) so they carry faithful hand-authored
 * monochrome marks in the same 24×24 single-path shape.
 */
export interface IntegrationBranding {
  /** Stable id — registry ids ('jira') plus upcoming ones not yet in IntegrationId. */
  id: string;
  name: string;
  vendor: string;
  /** One-line value prop shown under the name. */
  tagline: string;
  /** Brand accent for tinted containers/pills on dark surfaces. */
  brandColor: string;
  /** Official logo as raw SVG markup (renderers: SvgXml on RN, inline/img on web). */
  logoSvg: string;
}

export const INTEGRATION_BRANDING: Record<string, IntegrationBranding> = {
  // GitLab — the official multicolour Tanuki (from GitLab's own header markup),
  // like jira/slack. Kept verbatim: the four paths are the shape + the two
  // cheeks + the chin, and flattening them to one colour loses the mark.
  // `aria-hidden`/`role`/`class` were stripped — the renderers own a11y.
  gitlab: {
    id: 'gitlab',
    name: 'GitLab',
    vendor: 'GitLab',
    tagline: 'Merge requests, reviews & CI',
    brandColor: '#FC6D26',
    logoSvg:
      '<svg width="25" height="24" viewBox="0 0 25 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="m24.507 9.5-.034-.09L21.082.562a.896.896 0 0 0-1.694.091l-2.29 7.01H7.825L5.535.653a.898.898 0 0 0-1.694-.09L.451 9.411.416 9.5a6.297 6.297 0 0 0 2.09 7.278l.012.01.03.022 5.16 3.867 2.56 1.935 1.554 1.176a1.051 1.051 0 0 0 1.268 0l1.555-1.176 2.56-1.935 5.197-3.89.014-.01A6.297 6.297 0 0 0 24.507 9.5Z" fill="#E24329"/><path d="m24.507 9.5-.034-.09a11.44 11.44 0 0 0-4.56 2.051l-7.447 5.632 4.742 3.584 5.197-3.89.014-.01A6.297 6.297 0 0 0 24.507 9.5Z" fill="#FC6D26"/><path d="m7.707 20.677 2.56 1.935 1.555 1.176a1.051 1.051 0 0 0 1.268 0l1.555-1.176 2.56-1.935-4.743-3.584-4.755 3.584Z" fill="#FCA326"/><path d="M5.01 11.461a11.43 11.43 0 0 0-4.56-2.05L.416 9.5a6.297 6.297 0 0 0 2.09 7.278l.012.01.03.022 5.16 3.867 4.745-3.584-7.444-5.632Z" fill="#FC6D26"/></svg>',
  },
  // GitHub — now a REAL `IntegrationId` (`version_control`, `kind: 'connection'`).
  // It started life here as a brand-only entry, back when GitHub was rendered by
  // a hand-written special-case row; the mark is unchanged, it's just also the
  // catalog row's logo now. Still used by the PR/MR Command Center surfaces.
  github: {
    id: 'github',
    name: 'GitHub',
    vendor: 'GitHub',
    tagline: 'Pull requests, reviews & merges',
    brandColor: '#FFFFFF',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>GitHub</title><path fill="#FFFFFF" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
  },
  // GitHub Issues — the `tracker`-category toolkit integration (a real
  // `IntegrationId`, unlike the `github` entry above). Same official mark, its
  // own name/tagline so the catalog row reads as the issue tracker rather than
  // the code host.
  github_issues: {
    id: 'github_issues',
    name: 'GitHub Issues',
    vendor: 'GitHub',
    tagline: 'Issues & project tracking',
    brandColor: '#FFFFFF',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>GitHub</title><path fill="#FFFFFF" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
  },
  // npm — a brand-only entry (NOT an `IntegrationId`): the registry the
  // codeam-cli ships to. Present so surfaces like the Wiki can render the
  // official npm mark from the ONE shared catalog instead of a loose asset.
  npm: {
    id: 'npm',
    name: 'npm',
    vendor: 'npm, Inc.',
    tagline: 'The Node package registry',
    brandColor: '#CB3837',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>npm</title><path fill="#CB3837" d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.08 19.17H5.113z"/></svg>',
  },
  jira: {
    // Branding key kept 'jira' for id-stability; DISPLAY rebranded to Atlassian
    // (the one integration fronts both Jira + Confluence via mcp-atlassian).
    id: 'jira',
    name: 'Atlassian',
    vendor: 'Atlassian',
    tagline: 'Jira · Confluence',
    brandColor: '#357DE8',
    logoSvg:
      '<svg viewBox="0 0 32 32" height="32" xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true"><defs><linearGradient id="uid18" x1="14.8402" y1="15.8324" x2="8.6599" y2="26.5369" gradientUnits="userSpaceOnUse"><stop stop-color="#2684FF" stop-opacity="0.4" offset="0%"></stop><stop stop-color="#2684FF" offset="0.9228"></stop></linearGradient></defs><path fill="url(#uid18)" d="M11.6397 14.0398C11.2789 13.643 10.7378 13.679 10.4852 14.148L4.64091 25.8728C4.42446 26.3418 4.74912 26.8829 5.25419 26.8829H13.4074C13.6599 26.8829 13.9125 26.7386 14.0207 26.4861C15.7885 22.8424 14.7061 17.3227 11.6397 14.0398Z"></path><path fill="#357DE8" d="M15.9343 3.36124C12.6513 8.55622 12.8678 14.2923 15.0324 18.6215C17.1969 22.9506 18.8565 26.2336 18.9647 26.4861C19.0729 26.7386 19.3254 26.8829 19.578 26.8829H27.7312C28.2363 26.8829 28.597 26.3418 28.3445 25.8728C28.3445 25.8728 17.3774 3.93846 17.0887 3.39732C16.8723 2.89225 16.259 2.85618 15.9343 3.36124Z"></path></svg>',
  },
  confluence: {
    id: 'confluence',
    name: 'Confluence',
    vendor: 'Atlassian',
    tagline: 'Part of Atlassian · docs & wiki',
    brandColor: '#1868DB',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Confluence</title><path fill="#FFFFFF" d="M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.454-.763.733-1.221 1.967-3.247 3.945-2.853 7.508-1.146l4.957 2.337a.764.764 0 0 0 1.028-.382l2.364-5.346a.764.764 0 0 0-.382-1c-1.048-.494-3.124-1.478-4.965-2.361C10.911 10.97 5.224 11.185.87 18.257zM23.131 5.743c.249-.405.531-.875.764-1.25a.764.764 0 0 0-.256-1.034L18.675.404a.764.764 0 0 0-1.058.26c-.195.335-.451.763-.734 1.225-1.966 3.246-3.945 2.85-7.508 1.146L4.437.694a.764.764 0 0 0-1.027.382L1.046 6.422a.764.764 0 0 0 .382 1c1.039.49 3.105 1.467 4.965 2.361 6.698 3.246 12.392 3.029 16.738-4.04z"/></svg>',
  },
  slack: {
    id: 'slack',
    name: 'Slack',
    vendor: 'Salesforce',
    tagline: 'Team messaging & alerts',
    brandColor: '#E01E5A',
    logoSvg:
      '<svg width="54" height="54" viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_4127_70105)"><path d="M11.379 33.9993C11.379 37.1358 8.84512 39.6507 5.7276 39.6507C2.61008 39.6507 0.0572205 37.1168 0.0572205 33.9993C0.0572205 30.8817 2.5911 28.3479 5.70862 28.3479H11.36V33.9993H11.379Z" fill="#E01E5A"/><path d="M14.1962 33.9997C14.1962 30.8632 16.7301 28.3483 19.8476 28.3483C22.9651 28.3483 25.499 30.8822 25.499 33.9997V48.1353C25.499 51.2718 22.9651 53.7867 19.8476 53.7867C16.7301 53.7867 14.1962 51.2718 14.1962 48.1353V33.9997Z" fill="#E01E5A"/><path d="M19.8662 11.2673C16.7296 11.2673 14.2148 8.73347 14.2148 5.61594C14.2148 2.49842 16.7486 -0.0354538 19.8662 -0.0354538C22.9837 -0.0354538 25.5175 2.49842 25.5175 5.61594V11.2673H19.8662Z" fill="#36C5F0"/><path d="M19.8682 14.1334C23.0047 14.1334 25.5196 16.6673 25.5196 19.7848C25.5196 22.9023 22.9857 25.4362 19.8682 25.4362H5.67566C2.53916 25.4362 0.0242615 22.9023 0.0242615 19.7848C0.0242615 16.6673 2.55814 14.1334 5.67566 14.1334H19.8682Z" fill="#36C5F0"/><path d="M42.5323 19.7853C42.5323 16.6488 45.0662 14.1339 48.1837 14.1339C51.3012 14.1339 53.8351 16.6678 53.8351 19.7853C53.8351 22.9028 51.3012 25.4367 48.1837 25.4367H42.5323V19.7853Z" fill="#2EB67D"/><path d="M39.7126 19.7934C39.7126 22.9299 37.1787 25.4448 34.0612 25.4448C30.9436 25.4448 28.4098 22.911 28.4098 19.7934V5.61986C28.4098 2.48336 30.9436 -0.0315399 34.0612 -0.0315399C37.1787 -0.0315399 39.7126 2.48336 39.7126 5.61986V19.7934Z" fill="#2EB67D"/><path d="M34.0376 42.482C37.1741 42.482 39.689 45.0158 39.689 48.1334C39.689 51.2509 37.1552 53.7848 34.0376 53.7848C30.9201 53.7848 28.3862 51.2509 28.3862 48.1334V42.482H34.0376Z" fill="#ECB22E"/><path d="M34.0381 39.6507C30.9016 39.6507 28.3867 37.1168 28.3867 33.9993C28.3867 30.8818 30.9206 28.3479 34.0381 28.3479H48.2306C51.3671 28.3479 53.882 30.8818 53.882 33.9993C53.882 37.1168 51.3482 39.6507 48.2306 39.6507H34.0381Z" fill="#ECB22E"/></g><defs><clipPath id="clip0_4127_70105"><rect width="54" height="54" fill="white"/></clipPath></defs></svg>',
  },
  microsoft_teams: {
    id: 'microsoft_teams',
    name: 'Microsoft Teams',
    vendor: 'Microsoft',
    tagline: 'Team chat & collaboration',
    brandColor: '#6264A7',
    logoSvg:
      '<svg width="54" height="54" viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M36.6 22h12.3c1 0 1.8.8 1.8 1.8v10.4a7.2 7.2 0 0 1-7.2 7.2 7.2 7.2 0 0 1-7.2-7.2V22z" fill="#5059C9"/><circle cx="44" cy="14.4" r="4.6" fill="#5059C9"/><circle cx="27.2" cy="12" r="6.6" fill="#7B83EB"/><path d="M35.4 22H16.9c-1 .02-1.8.86-1.78 1.86v11.9A12 12 0 0 0 26.9 47.6a12 12 0 0 0 10.28-11.84V23.86c.02-1-.78-1.84-1.78-1.86z" fill="#7B83EB"/><path opacity=".12" d="M28 22v18.4a1.86 1.86 0 0 1-1.72 1.84H15.72A12.7 12.7 0 0 1 15.12 38V23.86c-.02-1 .78-1.84 1.78-1.86H28z" fill="#000"/><rect x="2.5" y="15" width="23.5" height="23.5" rx="2.2" fill="#4B53BC"/><path d="M19.8 21.4H8.7v3.05h4v11.1h3.1v-11.1h4V21.4z" fill="#fff"/></svg>',
  },
  google_chat: {
    id: 'google_chat',
    name: 'Google Chat',
    vendor: 'Google',
    tagline: 'Team messaging & spaces',
    brandColor: '#00AC47',
    logoSvg:
      '<svg width="54" height="54" viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M46 6H8a3.5 3.5 0 0 0-3.5 3.5v26A3.5 3.5 0 0 0 8 39h4.5v8.2a1.3 1.3 0 0 0 2.15 1L26 39h20a3.5 3.5 0 0 0 3.5-3.5v-26A3.5 3.5 0 0 0 46 6z" fill="#00AC47"/><circle cx="19.5" cy="22.5" r="3.1" fill="#fff"/><circle cx="34.5" cy="22.5" r="3.1" fill="#fff"/></svg>',
  },
  discord: {
    id: 'discord',
    name: 'Discord',
    vendor: 'Discord',
    tagline: 'Voice, video & text chat',
    brandColor: '#5865F2',
    logoSvg:
      '<svg width="54" height="54" viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M43.6 12.2A38 38 0 0 0 34.1 9.3a26 26 0 0 0-1.2 2.5 35.3 35.3 0 0 0-10.6 0 26 26 0 0 0-1.2-2.5 38 38 0 0 0-9.5 2.9C4.6 21.2 3 30 3.8 38.6a38.4 38.4 0 0 0 11.6 5.9 28 28 0 0 0 2.5-4 24.8 24.8 0 0 1-3.9-1.9c.33-.24.65-.5.95-.75a27.5 27.5 0 0 0 23.5 0c.3.27.62.52.95.75a24.8 24.8 0 0 1-3.9 1.9 28 28 0 0 0 2.5 4 38.3 38.3 0 0 0 11.6-5.9c.94-9.9-1.6-18.6-6.6-26.4zM19.4 33.3c-2.3 0-4.2-2.1-4.2-4.7s1.85-4.7 4.2-4.7 4.24 2.13 4.2 4.7c0 2.6-1.87 4.7-4.2 4.7zm15.3 0c-2.3 0-4.2-2.1-4.2-4.7s1.85-4.7 4.2-4.7 4.24 2.13 4.2 4.7c0 2.6-1.85 4.7-4.2 4.7z" fill="#5865F2"/></svg>',
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    vendor: 'Linear',
    tagline: 'Issue tracking for product teams',
    brandColor: '#5E6AD2',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Linear</title><path fill="#FFFFFF" d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/></svg>',
  },
  sentry: {
    id: 'sentry',
    name: 'Sentry',
    vendor: 'Sentry',
    tagline: 'Error & performance monitoring',
    brandColor: '#7B68C7',
    logoSvg:
      '<svg role="img" viewBox="0 0 50 44" xmlns="http://www.w3.org/2000/svg"><title>Sentry</title><path fill="#FFFFFF" d="M29,2.26a4.67,4.67,0,0,0-8,0L14.42,13.53A32.21,32.21,0,0,1,32.17,40.19H27.55A27.68,27.68,0,0,0,12.09,17.47L6,28a15.92,15.92,0,0,1,9.23,12.17H4.62A.76.76,0,0,1,4,39.06l2.94-5a10.74,10.74,0,0,0-3.36-1.9l-2.91,5a4.54,4.54,0,0,0,1.69,6.24A4.66,4.66,0,0,0,4.62,44H19.15a19.4,19.4,0,0,0-8-17.31l2.31-4A23.87,23.87,0,0,1,23.76,44H36.07a35.88,35.88,0,0,0-16.41-31.8l4.67-8a.77.77,0,0,1,1.05-.27c.53.29,20.29,34.77,20.66,35.17a.76.76,0,0,1-.68,1.13H40.6q.09,1.91,0,3.81h4.78A4.59,4.59,0,0,0,50,39.43a4.49,4.49,0,0,0-.62-2.28Z"></path></svg>',
  },
  notion: {
    id: 'notion',
    name: 'Notion',
    vendor: 'Notion Labs',
    tagline: 'Docs, wikis & knowledge',
    brandColor: '#E8E7E4',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Notion</title><path fill="#FFFFFF" d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"/></svg>',
  },
  azure_devops: {
    id: 'azure_devops',
    name: 'Azure DevOps',
    vendor: 'Microsoft',
    tagline: 'Boards, Repos & Pipelines',
    brandColor: '#0078D7',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Azure DevOps</title><path fill="#FFFFFF" d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z"/></svg>',
  },
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    vendor: 'Google',
    tagline: 'Read, search & send email',
    brandColor: '#EA4335',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Gmail</title><path fill="#FFFFFF" d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/></svg>',
  },
  posthog: {
    id: 'posthog',
    name: 'PostHog',
    vendor: 'PostHog',
    tagline: 'Product analytics & feature flags',
    brandColor: '#1D4AFF',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>PostHog</title><path fill="#FFFFFF" d="M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z"/></svg>',
  },
  clickup: {
    id: 'clickup',
    name: 'ClickUp',
    vendor: 'ClickUp',
    tagline: 'Tasks, docs & project management',
    brandColor: '#7B68EE',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>ClickUp</title><path fill="#FFFFFF" d="M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z"/></svg>',
  },
  figma: {
    id: 'figma',
    name: 'Figma',
    vendor: 'Figma',
    tagline: 'Designs, files & comments',
    brandColor: '#F24E1E',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Figma</title><path fill="#FFFFFF" d="M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z"/></svg>',
  },
  stitch: {
    id: 'stitch',
    name: 'Stitch',
    vendor: 'Google',
    tagline: 'AI UI design → code',
    brandColor: '#A855F7',
    // A simple 4-point design "sparkle" mark (Google Stitch has no simple-icons
    // entry) — white on dark, re-tintable via brandColor like the other marks.
    logoSvg:
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#FFFFFF" d="M12 1.5l1.9 6.3a4 4 0 0 0 2.3 2.3l6.3 1.9-6.3 1.9a4 4 0 0 0-2.3 2.3L12 22.5l-1.9-6.3a4 4 0 0 0-2.3-2.3L1.5 12l6.3-1.9a4 4 0 0 0 2.3-2.3L12 1.5z"/></svg>',
  },
  trello: {
    id: 'trello',
    name: 'Trello',
    vendor: 'Atlassian',
    tagline: 'Boards, lists & cards',
    brandColor: '#0052CC',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Trello</title><path fill="#FFFFFF" d="M21.147 0H2.853A2.86 2.86 0 000 2.853v18.294A2.86 2.86 0 002.853 24h18.294A2.86 2.86 0 0024 21.147V2.853A2.86 2.86 0 0021.147 0zM10.34 17.287a.953.953 0 01-.953.953h-4a.954.954 0 01-.954-.953V5.38a.953.953 0 01.954-.953h4a.954.954 0 01.953.953zm9.233-5.467a.944.944 0 01-.953.947h-4a.947.947 0 01-.953-.947V5.38a.953.953 0 01.953-.953h4a.954.954 0 01.953.953z"/></svg>',
  },
  resend: {
    id: 'resend',
    name: 'Resend',
    vendor: 'Resend',
    tagline: 'Transactional email delivery',
    brandColor: '#FFFFFF',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Resend</title><path fill="#FFFFFF" d="M14.679 0c4.648 0 7.413 2.765 7.413 6.434s-2.765 6.434-7.413 6.434H12.33L24 24h-8.245l-8.88-8.44c-.636-.588-.93-1.273-.93-1.86 0-.831.587-1.565 1.713-1.883l4.574-1.224c1.737-.465 2.936-1.81 2.936-3.572 0-2.153-1.761-3.4-3.939-3.4H0V0z"/></svg>',
  },
  vercel: {
    id: 'vercel',
    name: 'Vercel',
    vendor: 'Vercel',
    tagline: 'Deployments, logs & projects',
    brandColor: '#FFFFFF',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Vercel</title><path fill="#FFFFFF" d="m12 1.608 12 20.784H0Z"/></svg>',
  },
  supabase: {
    id: 'supabase',
    name: 'Supabase',
    vendor: 'Supabase',
    tagline: 'Postgres, auth & storage',
    brandColor: '#3FCF8E',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Supabase</title><path fill="#FFFFFF" d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z"/></svg>',
  },
  asana: {
    id: 'asana',
    name: 'Asana',
    vendor: 'Asana',
    tagline: 'Tasks, projects & workflows',
    brandColor: '#F06A6A',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Asana</title><path fill="#FFFFFF" d="M18.78 12.653c-2.882 0-5.22 2.336-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.34 5.22-5.22-2.336-5.22-5.22-5.22zm-13.56 0c-2.88 0-5.22 2.337-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.338 5.22-5.22-2.336-5.22-5.22-5.22zm12-6.525c0 2.883-2.337 5.22-5.22 5.22-2.882 0-5.22-2.337-5.22-5.22 0-2.88 2.338-5.22 5.22-5.22 2.883 0 5.22 2.34 5.22 5.22z"/></svg>',
  },
  postman: {
    id: 'postman',
    name: 'Postman',
    vendor: 'Postman',
    tagline: 'APIs, collections & environments',
    brandColor: '#FF6C37',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Postman</title><path fill="#FFFFFF" d="M13.527.099C6.955-.744.942 3.9.099 10.473c-.843 6.572 3.8 12.584 10.373 13.428 6.573.843 12.587-3.801 13.428-10.374C24.744 6.955 20.101.943 13.527.099zm2.471 7.485a.855.855 0 0 0-.593.25l-4.453 4.453-.307-.307-.643-.643c4.389-4.376 5.18-4.418 5.996-3.753zm-4.863 4.861l4.44-4.44a.62.62 0 1 1 .847.903l-4.699 4.125-.588-.588zm.33.694l-1.1.238a.06.06 0 0 1-.067-.032.06.06 0 0 1 .01-.073l.645-.645.512.512zm-2.803-.459l1.172-1.172.879.878-1.979.426a.074.074 0 0 1-.085-.039.072.072 0 0 1 .013-.093zm-3.646 6.058a.076.076 0 0 1-.069-.083.077.077 0 0 1 .022-.046h.002l.946-.946 1.222 1.222-2.123-.147zm2.425-1.256a.228.228 0 0 0-.117.256l.203.865a.125.125 0 0 1-.211.117h-.003l-.934-.934-.294-.295 3.762-3.758 1.82-.393.874.874c-1.255 1.102-2.971 2.201-5.1 3.268zm5.279-3.428h-.002l-.839-.839 4.699-4.125a.952.952 0 0 0 .119-.127c-.148 1.345-2.029 3.245-3.977 5.091zm3.657-6.46l-.003-.002a1.822 1.822 0 0 1 2.459-2.684l-1.61 1.613a.119.119 0 0 0 0 .169l1.247 1.247a1.817 1.817 0 0 1-2.093-.343zm2.578 0a1.714 1.714 0 0 1-.271.218h-.001l-1.207-1.207 1.533-1.533c.661.72.637 1.832-.054 2.522zM18.855 6.05a.143.143 0 0 0-.053.157.416.416 0 0 1-.053.45.14.14 0 0 0 .023.197.141.141 0 0 0 .084.03.14.14 0 0 0 .106-.05.691.691 0 0 0 .087-.751.138.138 0 0 0-.194-.033z"/></svg>',
  },
  n8n: {
    id: 'n8n',
    name: 'n8n',
    vendor: 'n8n',
    tagline: 'Workflow automation & webhooks',
    brandColor: '#EA4B71',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>n8n</title><path fill="#FFFFFF" d="M21.4737 5.6842c-1.1772 0-2.1663.8051-2.4468 1.8947h-2.8955c-1.235 0-2.289.893-2.492 2.111l-.1038.623a1.263 1.263 0 0 1-1.246 1.0555H11.289c-.2805-1.0896-1.2696-1.8947-2.4468-1.8947s-2.1663.8051-2.4467 1.8947H4.973c-.2805-1.0896-1.2696-1.8947-2.4468-1.8947C1.1311 9.4737 0 10.6047 0 12s1.131 2.5263 2.5263 2.5263c1.1772 0 2.1663-.8051 2.4468-1.8947h1.4223c.2804 1.0896 1.2696 1.8947 2.4467 1.8947 1.1772 0 2.1663-.8051 2.4468-1.8947h1.0008a1.263 1.263 0 0 1 1.2459 1.0555l.1038.623c.203 1.218 1.257 2.111 2.492 2.111h.3692c.2804 1.0895 1.2696 1.8947 2.4468 1.8947 1.3952 0 2.5263-1.131 2.5263-2.5263s-1.131-2.5263-2.5263-2.5263c-1.1772 0-2.1664.805-2.4468 1.8947h-.3692a1.263 1.263 0 0 1-1.246-1.0555l-.1037-.623A2.52 2.52 0 0 0 13.9607 12a2.52 2.52 0 0 0 .821-1.4794l.1038-.623a1.263 1.263 0 0 1 1.2459-1.0555h2.8955c.2805 1.0896 1.2696 1.8947 2.4468 1.8947 1.3952 0 2.5263-1.131 2.5263-2.5263s-1.131-2.5263-2.5263-2.5263m0 1.2632a1.263 1.263 0 0 1 1.2631 1.2631 1.263 1.263 0 0 1-1.2631 1.2632 1.263 1.263 0 0 1-1.2632-1.2632 1.263 1.263 0 0 1 1.2632-1.2631M2.5263 10.7368A1.263 1.263 0 0 1 3.7895 12a1.263 1.263 0 0 1-1.2632 1.2632A1.263 1.263 0 0 1 1.2632 12a1.263 1.263 0 0 1 1.2631-1.2632m6.3158 0A1.263 1.263 0 0 1 10.1053 12a1.263 1.263 0 0 1-1.2632 1.2632A1.263 1.263 0 0 1 7.579 12a1.263 1.263 0 0 1 1.2632-1.2632m10.1053 3.7895a1.263 1.263 0 0 1 1.2631 1.2632 1.263 1.263 0 0 1-1.2631 1.2631 1.263 1.263 0 0 1-1.2632-1.2631 1.263 1.263 0 0 1 1.2632-1.2632"/></svg>',
  },
  stripe: {
    id: 'stripe',
    name: 'Stripe',
    vendor: 'Stripe',
    tagline: 'Payments, customers & invoices',
    brandColor: '#635BFF',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Stripe</title><path fill="#FFFFFF" d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z"/></svg>',
  },
  mixpanel: {
    id: 'mixpanel',
    name: 'Mixpanel',
    vendor: 'Mixpanel',
    tagline: 'Product & user analytics',
    brandColor: '#7856FF',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Mixpanel</title><path fill="#FFFFFF" d="M6.967 9.996h3.053c-.763-.477-1.048-1.145-1.431-2.384L7.443 3.366C6.919 1.458 6.49.551 4.39.551H.004v1.145h.621c1.286 0 1.431.477 1.814 1.908L3.44 7.326c.524 1.814 1.337 2.67 3.53 2.67h-.003Zm7.06 0h3.053c2.194 0 2.956-.86 3.484-2.67l1.001-3.722c.382-1.431.57-1.908 1.814-1.908H24V.551h-4.34c-2.146 0-2.576.86-3.053 2.815l-1.145 4.246c-.384 1.286-.673 1.907-1.435 2.384Zm-4.007 4.008h4.007V9.996H10.02v4.008ZM0 23.449h4.39c2.1 0 2.529-.907 3.053-2.815l1.146-4.246c.383-1.239.668-1.907 1.431-2.384H6.967c-2.194 0-3.007.86-3.531 2.67l-1.001 3.722c-.383 1.431-.524 1.907-1.814 1.907H0v1.146Zm19.65 0h4.343v-1.146h-.622c-1.239 0-1.431-.476-1.814-1.907l-1.001-3.722c-.524-1.814-1.286-2.67-3.483-2.67h-3.046c.762.477 1.041 1.098 1.424 2.384l1.145 4.246c.477 1.955.907 2.815 3.054 2.815Z"/></svg>',
  },
  pendo: {
    id: 'pendo',
    name: 'Pendo',
    vendor: 'Pendo',
    tagline: 'Product analytics & user guides',
    brandColor: '#EC2588',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Pendo</title><path fill="#FFFFFF" d="M3 3h13.5A4.5 4.5 0 0 1 21 7.5v9A4.5 4.5 0 0 1 16.5 21H3V3Zm5 4v10h3v-3h2.2a3.5 3.5 0 0 0 0-7H8Zm3 2h1.9a1.5 1.5 0 0 1 0 3H11V9Z"/></svg>',
  },
  pagerduty: {
    id: 'pagerduty',
    name: 'PagerDuty',
    vendor: 'PagerDuty',
    tagline: 'Incidents, alerts & on-call',
    brandColor: '#06AC38',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>PagerDuty</title><path fill="#FFFFFF" d="M16.965 1.18C15.085.164 13.769 0 10.683 0H3.73v14.55h6.926c2.743 0 4.8-.164 6.61-1.37 1.975-1.303 3.004-3.484 3.004-6.007 0-2.716-1.262-4.896-3.305-5.994zm-5.5 10.326h-4.21V3.113l3.977-.027c3.62-.028 5.43 1.234 5.43 4.128 0 3.113-2.248 4.292-5.197 4.292zM3.73 17.61h3.525V24H3.73Z"/></svg>',
  },
  amplitude: {
    id: 'amplitude',
    name: 'Amplitude',
    vendor: 'Amplitude',
    tagline: 'Digital analytics & experiments',
    brandColor: '#1F6FFF',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Amplitude</title><path fill="#FFFFFF" d="M1 21h2V11H1v10Zm4 0h2V6H5v15Zm4 0h2V3H9v18Zm4 0h2V6h-2v15Zm4 0h2v-8h-2v8Zm4 0h2v-5h-2v5Z"/></svg>',
  },
  datadog: {
    id: 'datadog',
    name: 'Datadog',
    vendor: 'Datadog',
    tagline: 'Metrics, logs & monitoring',
    brandColor: '#632CA6',
    logoSvg:
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Datadog</title><path fill="#FFFFFF" d="M19.57 17.04l-1.997-1.316-1.665 2.782-1.937-.567-1.706 2.604.087.82 9.274-1.71-.538-5.794zm-8.649-2.498l1.488-.204c.241.108.409.15.697.223.45.117.97.23 1.741-.16.18-.088.553-.43.704-.625l6.096-1.106.622 7.527-10.444 1.882zm11.325-2.712l-.602.115L20.488 0 .789 2.285l2.427 19.693 2.306-.334c-.184-.263-.471-.581-.96-.989-.68-.564-.44-1.522-.039-2.127.53-1.022 3.26-2.322 3.106-3.956-.056-.594-.15-1.368-.702-1.898-.02.22.017.432.017.432s-.227-.289-.34-.683c-.112-.15-.2-.199-.319-.4-.085.233-.073.503-.073.503s-.186-.437-.216-.807c-.11.166-.137.48-.137.48s-.241-.69-.186-1.062c-.11-.323-.436-.965-.343-2.424.6.421 1.924.321 2.44-.439.171-.251.288-.939-.086-2.293-.24-.868-.835-2.16-1.066-2.651l-.028.02c.122.395.374 1.223.47 1.625.293 1.218.372 1.642.234 2.204-.116.488-.397.808-1.107 1.165-.71.358-1.653-.514-1.713-.562-.69-.55-1.224-1.447-1.284-1.883-.062-.477.275-.763.445-1.153-.243.07-.514.192-.514.192s.323-.334.722-.624c.165-.109.262-.178.436-.323a9.762 9.762 0 0 0-.456.003s.42-.227.855-.392c-.318-.014-.623-.003-.623-.003s.937-.419 1.678-.727c.509-.208 1.006-.147 1.286.257.367.53.752.817 1.569.996.501-.223.653-.337 1.284-.509.554-.61.99-.688.99-.688s-.216.198-.274.51c.314-.249.66-.455.66-.455s-.134.164-.259.426l.03.043c.366-.22.797-.394.797-.394s-.123.156-.268.358c.277-.002.838.012 1.056.037 1.285.028 1.552-1.374 2.045-1.55.618-.22.894-.353 1.947.68.903.888 1.609 2.477 1.259 2.833-.294.295-.874-.115-1.516-.916a3.466 3.466 0 0 1-.716-1.562 1.533 1.533 0 0 0-.497-.85s.23.51.23.96c0 .246.03 1.165.424 1.68-.039.076-.057.374-.1.43-.458-.554-1.443-.95-1.604-1.067.544.445 1.793 1.468 2.273 2.449.453.927.186 1.777.416 1.997.065.063.976 1.197 1.15 1.767.306.994.019 2.038-.381 2.685l-1.117.174c-.163-.045-.273-.068-.42-.153.08-.143.241-.5.243-.572l-.063-.111c-.348.492-.93.97-1.414 1.245-.633.359-1.363.304-1.838.156-1.348-.415-2.623-1.327-2.93-1.566 0 0-.01.191.048.234.34.383 1.119 1.077 1.872 1.56l-1.605.177.759 5.908c-.337.048-.39.071-.757.124-.325-1.147-.946-1.895-1.624-2.332-.599-.384-1.424-.47-2.214-.314l-.05.059a2.851 2.851 0 0 1 1.863.444c.654.413 1.181 1.481 1.375 2.124.248.822.42 1.7-.248 2.632-.476.662-1.864 1.028-2.986.237.3.481.705.876 1.25.95.809.11 1.577-.03 2.106-.574.452-.464.69-1.434.628-2.456l.714-.104.258 1.834 11.827-1.424zM15.05 6.848c-.034.075-.085.125-.007.37l.004.014.013.032.032.073c.14.287.295.558.552.696.067-.011.136-.019.207-.023.242-.01.395.028.492.08.009-.048.01-.119.005-.222-.018-.364.072-.982-.626-1.308-.264-.122-.634-.084-.757.068a.302.302 0 0 1 .058.013c.186.066.06.13.027.207m1.958 3.392c-.092-.05-.52-.03-.821.005-.574.068-1.193.267-1.328.372-.247.191-.135.523.047.66.511.382.96.638 1.432.575.29-.038.546-.497.728-.914.124-.288.124-.598-.058-.698m-5.077-2.942c.162-.154-.805-.355-1.556.156-.554.378-.571 1.187-.041 1.646.053.046.096.078.137.104a4.77 4.77 0 0 1 1.396-.412c.113-.125.243-.345.21-.745-.044-.542-.455-.456-.146-.749"/></svg>',
  },
};

export const UPCOMING_INTEGRATION_IDS = [
  'gmail',
  'asana',
  'stripe',
  'pendo',
  'pagerduty',
  'amplitude',
] as const;

export function getIntegrationBranding(id: string): IntegrationBranding | null {
  return INTEGRATION_BRANDING[id] ?? null;
}
