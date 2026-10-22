/**
 * The page's icons: fixed path data drawn with `createElementNS`, stroked in
 * `currentColor`. No markup is parsed and nothing is loaded from elsewhere;
 * every icon is decorative (`aria-hidden`), the text next to it carries the meaning.
 */

const PATHS = {
  status: 'M3 12h4l3-8 4 16 3-8h4',
  plan: 'M12 15V3M7 8l5-5 5 5M5 21h14',
  history: 'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5M12 7v5l3 2',
  run: 'M4 17l6-5-6-5M12 19h8',
  targets: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  server: 'M5 4h14v6H5zM5 14h14v6H5zM8 7h.01M8 17h.01',
  app: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  check: 'M5 12l5 5L20 7',
  cross: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.5h.01',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 1 1 0-18zM12 11v6M12 7.5h.01',
  ok: 'M12 3a9 9 0 1 1 0 18 9 9 0 1 1 0-18zM8 12.5l3 3 5-6',
  error: 'M12 3a9 9 0 1 1 0 18 9 9 0 1 1 0-18zM12 7.5v5.5M12 16.5h.01',
  shield: 'M12 3l8 3v6c0 4.5-3.4 7.8-8 9-4.6-1.2-8-4.5-8-9V6z',
  power: 'M12 3v8M6.3 6.6a8 8 0 1 0 11.4 0',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5M4 3v4h4M4 13a8 8 0 0 0 14.6 4.5M20 21v-4h-4',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1.5 2h5L16 13h5',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8h.01',
  chevron: 'M9 6l6 6-6 6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  commit: 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 1 1 0-7zM3 12h5.5M15.5 12H21',
  globe: 'M12 3a9 9 0 1 1 0 18 9 9 0 1 1 0-18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9s1.3-6.5 3.8-9z',
  merge: 'M7 4v10M7 14a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM17 4a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM17 10c0 4-4 6-10 6',
} as const

export type IconName = keyof typeof PATHS

const SVG = 'http://www.w3.org/2000/svg'

export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.75')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', PATHS[name])
  svg.appendChild(path)
  return svg
}
