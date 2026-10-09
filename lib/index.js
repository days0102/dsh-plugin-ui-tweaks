/**
 * dsh Web GUI UI tweaks — node half.
 *
 * Empty apply: every adjustment this package ships lives in the browser half. The
 * host-side row exists so dsh-client-modules discovers the `dsh.client` declaration
 * in package.json and serves `exports["./client"]` to the page.
 */

/** Host plugin body — no host-side behaviour. */
export function apply() {}
