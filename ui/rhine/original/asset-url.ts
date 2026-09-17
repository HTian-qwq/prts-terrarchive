/** Host integration only: preserve upstream asset paths under the plugin base. */
let base = '/';
export const setAssetBase = (value: string) => { base = `${value.replace(/\/$/, '')}/`; };
export const assetUrl = (path: string) => `${base}${path.replace(/^\//, '')}`;
