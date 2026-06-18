import { z } from 'zod';

export const BrowserAcceptanceStrategy = z.enum([
  'bundled_chromium_automated',
  'chrome_manual_load_unpacked',
  'edge_manual_load_unpacked',
]);
export type BrowserAcceptanceStrategy = z.infer<typeof BrowserAcceptanceStrategy>;

export interface BrowserStrategyAdvice {
  strategy: BrowserAcceptanceStrategy;
  browserLabel: 'chromium' | 'chrome' | 'edge';
  automated: boolean;
  supported: boolean;
  notes: string[];
}

export function browserStrategyAdvice(strategy: BrowserAcceptanceStrategy): BrowserStrategyAdvice {
  switch (strategy) {
    case 'bundled_chromium_automated':
      return {
        strategy,
        browserLabel: 'chromium',
        automated: true,
        supported: true,
        notes: ['Use Playwright bundled Chromium with a persistent context and --load-extension.'],
      };
    case 'chrome_manual_load_unpacked':
      return {
        strategy,
        browserLabel: 'chrome',
        automated: false,
        supported: true,
        notes: ['Use Chrome Developer mode and Load unpacked. Do not use installed Chrome command-line sideload automation.'],
      };
    case 'edge_manual_load_unpacked':
      return {
        strategy,
        browserLabel: 'edge',
        automated: false,
        supported: true,
        notes: ['Use Edge Developer mode and Load unpacked. Do not use installed Edge command-line sideload automation.'],
      };
    default:
      return assertNever(strategy);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported browser acceptance strategy: ${value}`);
}
