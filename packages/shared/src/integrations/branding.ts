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
 * multicolor originals (from the vendor). linear/sentry/notion are
 * simple-icons single-path marks that ship with a black fill by default —
 * that fill has been rewritten here to #FFFFFF so the mark reads on the
 * dark surfaces this catalog targets; consumers may re-tint via
 * `brandColor` (e.g. an SVG `<mask>`/currentColor wrapper) if a different
 * treatment is needed.
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
  slack: {
    id: 'slack',
    name: 'Slack',
    vendor: 'Salesforce',
    tagline: 'Team messaging & alerts',
    brandColor: '#E01E5A',
    logoSvg:
      '<svg width="54" height="54" viewBox="0 0 54 54" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_4127_70105)"><path d="M11.379 33.9993C11.379 37.1358 8.84512 39.6507 5.7276 39.6507C2.61008 39.6507 0.0572205 37.1168 0.0572205 33.9993C0.0572205 30.8817 2.5911 28.3479 5.70862 28.3479H11.36V33.9993H11.379Z" fill="#E01E5A"/><path d="M14.1962 33.9997C14.1962 30.8632 16.7301 28.3483 19.8476 28.3483C22.9651 28.3483 25.499 30.8822 25.499 33.9997V48.1353C25.499 51.2718 22.9651 53.7867 19.8476 53.7867C16.7301 53.7867 14.1962 51.2718 14.1962 48.1353V33.9997Z" fill="#E01E5A"/><path d="M19.8662 11.2673C16.7296 11.2673 14.2148 8.73347 14.2148 5.61594C14.2148 2.49842 16.7486 -0.0354538 19.8662 -0.0354538C22.9837 -0.0354538 25.5175 2.49842 25.5175 5.61594V11.2673H19.8662Z" fill="#36C5F0"/><path d="M19.8682 14.1334C23.0047 14.1334 25.5196 16.6673 25.5196 19.7848C25.5196 22.9023 22.9857 25.4362 19.8682 25.4362H5.67566C2.53916 25.4362 0.0242615 22.9023 0.0242615 19.7848C0.0242615 16.6673 2.55814 14.1334 5.67566 14.1334H19.8682Z" fill="#36C5F0"/><path d="M42.5323 19.7853C42.5323 16.6488 45.0662 14.1339 48.1837 14.1339C51.3012 14.1339 53.8351 16.6678 53.8351 19.7853C53.8351 22.9028 51.3012 25.4367 48.1837 25.4367H42.5323V19.7853Z" fill="#2EB67D"/><path d="M39.7126 19.7934C39.7126 22.9299 37.1787 25.4448 34.0612 25.4448C30.9436 25.4448 28.4098 22.911 28.4098 19.7934V5.61986C28.4098 2.48336 30.9436 -0.0315399 34.0612 -0.0315399C37.1787 -0.0315399 39.7126 2.48336 39.7126 5.61986V19.7934Z" fill="#2EB67D"/><path d="M34.0376 42.482C37.1741 42.482 39.689 45.0158 39.689 48.1334C39.689 51.2509 37.1552 53.7848 34.0376 53.7848C30.9201 53.7848 28.3862 51.2509 28.3862 48.1334V42.482H34.0376Z" fill="#ECB22E"/><path d="M34.0381 39.6507C30.9016 39.6507 28.3867 37.1168 28.3867 33.9993C28.3867 30.8818 30.9206 28.3479 34.0381 28.3479H48.2306C51.3671 28.3479 53.882 30.8818 53.882 33.9993C53.882 37.1168 51.3482 39.6507 48.2306 39.6507H34.0381Z" fill="#ECB22E"/></g><defs><clipPath id="clip0_4127_70105"><rect width="54" height="54" fill="white"/></clipPath></defs></svg>',
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
};

export const UPCOMING_INTEGRATION_IDS = ['slack', 'linear', 'sentry', 'notion'] as const;

export function getIntegrationBranding(id: string): IntegrationBranding | null {
  return INTEGRATION_BRANDING[id] ?? null;
}
