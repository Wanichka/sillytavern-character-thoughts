// Optional Roleplay Tools API v1 bridge. This file ships with the extension:
// no import from another extension folder, no dependency on its install name.
export function isRoleplayDocked(element) {
    return element?.dataset.rptDocked === 'true';
}

export function registerRoleplayPanel(descriptor) {
    const connect = () => {
        const host = window.WaniRoleplayTools;
        if (host?.version !== 1) return;
        try { host.register(descriptor); }
        catch (error) { console.warn('[Roleplay Tools adapter] Registration failed:', error); }
    };
    // Host first: connect now. Extension first: connect on the ready event.
    window.addEventListener('wani-roleplay-tools:ready', connect);
    descriptor.launcher?.addEventListener('click', event => {
        if (!isRoleplayDocked(descriptor.element)) return;
        if (window.WaniRoleplayTools?.open(descriptor.id)) {
            event.preventDefault(); event.stopImmediatePropagation();
        }
    }, true);
    connect();
}
