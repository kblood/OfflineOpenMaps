// Keep the v2 workspaces isolated from the legacy OpenMaps PostCSS/Tailwind
// configuration in the parent directory. The v2 shells use authored CSS and
// do not need a PostCSS transform.
module.exports = { plugins: {} };
