import type { BrowserContext, Route } from 'playwright';

const ROUTE_PATTERN = '**/*';

const cspRouteHandlers = new WeakMap<BrowserContext, (route: Route) => Promise<void>>();

function createCspStripHandler() {
  return async function cspStripHandler(route: Route) {
    try {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers['content-security-policy'];
      delete headers['content-security-policy-report-only'];
      await route.fulfill({ response, headers });
    } catch {
      try {
        await route.continue();
      } catch {
        // Ignore teardown races.
      }
    }
  };
}

export async function installCspStripRoute(context: BrowserContext): Promise<void> {
  let handler = cspRouteHandlers.get(context);
  if (!handler) {
    handler = createCspStripHandler();
    cspRouteHandlers.set(context, handler);
  }

  await context.route(ROUTE_PATTERN, handler);
}

export async function uninstallCspStripRoute(context: BrowserContext): Promise<void> {
  const handler = cspRouteHandlers.get(context);
  if (!handler) {
    return;
  }

  try {
    await context.unroute(ROUTE_PATTERN, handler);
  } catch {
    // Ignore teardown races or already-detached contexts.
  }
}
