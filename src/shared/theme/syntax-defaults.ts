import type { SyntaxKey } from './theme-file'

export const DEFAULT_SYNTAX: Record<'dark' | 'light', Record<SyntaxKey, string>> = {
  dark: {
    keyword: '#c678dd', string: '#98c379', comment: '#7f848e', function: '#61afef',
    type: '#e5c07b', number: '#d19a66', operator: '#56b6c2', property: '#d19a66',
    tag: '#e06c75', variable: '#abb2bf', constant: '#d19a66', heading: '#c678dd',
    link: '#98c379', list: '#d19a66', quote: '#abb2bf', meta: '#abb2bf',
    mark: '#c678dd', invalid: '#f44747',
    'active-line-bg': 'rgba(255, 255, 255, 0.04)',
    'selection-bg': 'rgba(61, 90, 254, 0.35)',
    'selection-match-bg': 'rgba(255, 255, 255, 0.06)',
  },
  light: {
    keyword: '#a626a4', string: '#50a14f', comment: '#696c77', function: '#4078f2',
    type: '#c18401', number: '#986801', operator: '#0184bc', property: '#986801',
    tag: '#e45649', variable: '#383a42', constant: '#986801', heading: '#a626a4',
    link: '#50a14f', list: '#986801', quote: '#696c77', meta: '#696c77',
    mark: '#a626a4', invalid: '#d52753',
    'active-line-bg': 'rgba(0, 0, 0, 0.035)',
    'selection-bg': 'rgba(37, 99, 235, 0.22)',
    'selection-match-bg': 'rgba(0, 0, 0, 0.05)',
  },
}
