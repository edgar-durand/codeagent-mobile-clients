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
    id: 'jira',
    name: 'Jira',
    vendor: 'Atlassian',
    tagline: 'Issues, sprints & workflows',
    brandColor: '#2684FF',
    logoSvg:
      '<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M27.0055 4H15.4512C15.4512 6.88 17.7826 9.21143 20.6626 9.21143H22.7883V11.2686C22.7883 14.1486 25.1197 16.48 27.9997 16.48V4.99429C27.9997 4.44571 27.554 4 27.0055 4Z" fill="#2684FF"/><path d="M21.2799 9.76001H9.72559C9.72559 12.64 12.057 14.9714 14.937 14.9714H17.0627V17.0286C17.0627 19.9086 19.3942 22.24 22.2742 22.24V10.7543C22.2742 10.2057 21.8284 9.76001 21.2799 9.76001Z" fill="url(#paint0_linear)"/><path d="M15.5543 15.52H4C4 18.4 6.33143 20.7314 9.21143 20.7314H11.3371V22.7886C11.3371 25.6686 13.6686 28 16.5486 28V16.5143C16.5486 15.9657 16.1029 15.52 15.5543 15.52Z" fill="url(#paint1_linear)"/><defs><linearGradient id="paint0_linear" x1="22.0343" y1="9.77256" x2="17.1181" y2="14.8424" gradientUnits="userSpaceOnUse"><stop offset="0.176" stop-color="#0052CC"/><stop offset="1" stop-color="#2684FF"/></linearGradient><linearGradient id="paint1_linear" x1="16.6411" y1="15.5637" x2="10.9568" y2="21.0943" gradientUnits="userSpaceOnUse"><stop offset="0.176" stop-color="#0052CC"/><stop offset="1" stop-color="#2684FF"/></linearGradient></defs></svg>',
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
      '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Sentry</title><path fill="#FFFFFF" d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z"/></svg>',
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
};

export const UPCOMING_INTEGRATION_IDS = ['slack', 'linear', 'sentry', 'notion'] as const;

export function getIntegrationBranding(id: string): IntegrationBranding | null {
  return INTEGRATION_BRANDING[id] ?? null;
}
