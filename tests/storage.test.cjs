const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function boot(seed = {}, cards = [{ name: 'Law', avatar: 'Law.png' }, { name: 'Law', avatar: 'Law2.png' }]) {
    const storage = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
    const context = { characters: cards, characterId: 0, groupId: null, chatId: 'chat-a', chat: [] };
    const sandbox = {
        console, URL, setTimeout() {},
        window: { SillyTavern: { getContext: () => context } },
        document: {
            querySelector: () => null,
            createElement: () => ({ set innerHTML(v) { this.textContent = v.replace(/<[^>]*>/g, ''); } }),
        },
        localStorage: {
            getItem: k => storage.get(k) ?? null,
            setItem: (k, v) => storage.set(k, v),
        },
    };
    const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8')
        .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '')
        .replaceAll('import.meta.url', "'https://example.test/extensions/thoughts/index.js'");
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    return { api: sandbox, context, storage, read: k => JSON.parse(storage.get(k) || 'null') };
}

test('same-named cards keep independent uploads and switch back automatically', () => {
    const { api, context } = boot();
    const first = api.getActiveProfileId();
    api.setUploadedAvatar('Law', 'data:first');
    context.characterId = 1;
    assert.notEqual(api.getActiveProfileId(), first);
    assert.equal(api.resolveAvatarSrc('Law'), null);
    api.setUploadedAvatar('Law', 'data:second');
    context.characterId = 0;
    assert.equal(api.resolveAvatarSrc('Law'), 'data:first');
    context.chatId = 'another-chat';
    assert.equal(api.getActiveProfileId(), first);
});

test('first access returns the created profile, not a stale default', () => {
    const { api } = boot();
    assert.equal(api.getActiveProfile().name, 'Law');
});

test('display name changes and card reordering do not change bindings', () => {
    const { api, context } = boot();
    const id = api.getActiveProfileId();
    context.characters[0].name = 'Trafalgar';
    assert.equal(api.getActiveProfileId(), id);
    context.characters.reverse();
    context.characterId = 1;
    assert.equal(api.getActiveProfileId(), id);
});

test('legacy profiles migrate without deleting originals or coupling duplicate names', () => {
    const legacy = { name: 'Medicine', folder: 'Medicine AU', uploads: { Law: 'data:old' }, avatars: { Bepo: 'bepo.png' } };
    const { api, context, read } = boot({ ct_profiles_v1: { old: legacy }, ct_cardmap_v1: { Law: 'old' } });
    const id = api.getActiveProfileId();
    assert.equal(api.resolveAvatarSrc('Law'), 'data:old');
    api.setUploadedAvatar('Law', 'data:new');
    context.characterId = 1;
    assert.notEqual(api.getActiveProfileId(), id);
    assert.equal(api.resolveAvatarSrc('Law'), 'data:old');
    assert.deepEqual(read('ct_profiles_v1').old, legacy);
});

test('saved roster retains departed characters, including old upload-only entries', () => {
    const { api } = boot();
    api.getActiveProfileId();
    api.setUploadedAvatar('Penguin', 'data:penguin');
    api.updateFromText('<char_thoughts>Law: hello; Bepo: hi</char_thoughts>');
    api.updateFromText('<char_thoughts>Law: later</char_thoughts>');
    assert.deepEqual([...api.getActiveProfile().characters].sort(), ['Bepo', 'Law', 'Penguin']);
    assert.deepEqual(Object.keys(api.getThoughts()), ['Law']);
});

test('opening chat backfills history, excluding user and system text', () => {
    const { api, context } = boot();
    context.chat = [
        { mes: '<char_thoughts>Bepo: past</char_thoughts>' },
        { mes: '<char_mood>Law: happy</char_mood>' },
        { is_user: true, mes: '<char_thoughts>User: sample</char_thoughts>' },
        { is_system: true, mes: '<char_thoughts>System: sample</char_thoughts>' },
    ];
    api.handleChatChanged();
    assert.deepEqual([...api.getActiveProfile().characters].sort(), ['Bepo', 'Law']);
});

test('manual removal survives reparse, history backfill and reload', () => {
    const { api, context, storage } = boot();
    context.chat = [{ mes: '<char_thoughts>Bepo: hello</char_thoughts>' }];
    api.handleChatChanged();
    api.setUploadedAvatar('Bepo', 'data:bepo');
    api.removeCharacter('Bepo', api.getActiveProfileId());
    api.updateFromText(context.chat[0].mes);
    api.handleChatChanged();
    assert.equal(api.getActiveProfile().characters.includes('Bepo'), false);
    assert.equal(api.resolveAvatarSrc('Bepo'), null);
    const reloaded = boot(Object.fromEntries([...storage].map(([k, v]) => [k, JSON.parse(v)])));
    reloaded.api.rememberCharacters(['Bepo']);
    assert.equal(reloaded.api.getActiveProfile().characters.includes('Bepo'), false);
});

test('upload finishing after card switch saves to its original profile', () => {
    const { api, context } = boot();
    const original = api.getActiveProfileId();
    context.characterId = 1;
    api.getActiveProfileId();
    api.setUploadedAvatar('Law', 'data:delayed', original);
    assert.equal(api.resolveAvatarSrc('Law'), null);
    context.characterId = 0;
    assert.equal(api.resolveAvatarSrc('Law'), 'data:delayed');
});

test('folder and filenames preserve spelling and encode URL characters', () => {
    const { api } = boot();
    const id = api.getActiveProfileId();
    const profiles = api.getProfiles();
    profiles[id].folder = 'Medicine AU';
    profiles[id].avatars.Law = 'Ло #1.png';
    api.saveProfiles(profiles);
    assert.equal(api.resolveAvatarSrc('Law'), 'https://example.test/extensions/thoughts/avatars/Medicine%20AU/%D0%9B%D0%BE%20%231.png');
    for (const invalid of ['', '.', '..', '../test', 'C:\\images']) assert.equal(api.validPathPart(invalid), false);
    assert.equal(api.validPathPart('Medicine AU'), true);
});

test('manual profile selection survives chat/card switching and group speakers', () => {
    const { api, context } = boot();
    api.ensureProfile('manual:au', 'AU');
    api.setActiveProfileId('manual:au');
    context.characterId = 1;
    assert.notEqual(api.getActiveProfileId(), 'manual:au');
    context.characterId = 0;
    assert.equal(api.getActiveProfileId(), 'manual:au');
    context.groupId = 42;
    const groupId = api.getActiveProfileId();
    context.characterId = 1;
    assert.equal(api.getActiveProfileId(), groupId);
    assert.notEqual(groupId, 'manual:au');
});

test('missing and deleted profiles recover without resurrecting legacy avatars', () => {
    const { api } = boot({ ct_cardmap_v2: { 'card:Law.png': null }, ct_cardmap_v1: { Law: 'old' }, ct_profiles_v1: { old: { uploads: { Law: 'data:old' } } } });
    assert.equal(api.resolveAvatarSrc('Law'), null);
    api.saveCardMap({ 'card:Law.png': 'missing' });
    assert.ok(api.getActiveProfileId());
});

test('no open card does not create or bind a phantom default profile', () => {
    const { api, context, read } = boot();
    context.characterId = undefined;
    assert.equal(api.getActiveProfileId(), null);
    api.rememberChatCharacters();
    assert.equal(read('ct_profiles_v1'), null);
});
