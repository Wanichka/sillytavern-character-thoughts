const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function boot(seed = {
    ct_profiles_v1: {
        first: { name: 'Medicine', folder: 'medicine', avatars: {}, uploads: {}, characters: [] },
        second: { name: 'Mafia', folder: 'mafia', avatars: {}, uploads: {}, characters: [] },
    },
    ct_cardmap_v2: { 'card:Law.png': 'first', 'card:Law2.png': 'second' },
}, cards = [{ name: 'Law', avatar: 'Law.png' }, { name: 'Law', avatar: 'Law2.png' }]) {
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

test('first access returns the selected profile', () => {
    const { api } = boot();
    assert.equal(api.getActiveProfile().name, 'Medicine');
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

test('unbound cards never copy legacy avatars or rosters based on their name', () => {
    const legacy = { name: 'Medicine', folder: 'Medicine AU', uploads: { Law: 'data:old' }, avatars: { Bepo: 'bepo.png' } };
    const { api, context, read } = boot({ ct_profiles_v1: { old: legacy }, ct_cardmap_v1: { Law: 'old' } });
    const id = api.getActiveProfileId();
    assert.equal(api.resolveAvatarSrc('Law'), null);
    assert.equal(id, null);
    api.setUploadedAvatar('Law', 'data:new');
    context.characterId = 1;
    assert.equal(api.getActiveProfileId(), null);
    assert.equal(api.resolveAvatarSrc('Law'), null);
    assert.deepEqual(read('ct_profiles_v1').old, legacy);
});

test('existing bindings, uploaded avatars and saved names survive the update unchanged', () => {
    const profile = { name: 'mafia', folder: 'mafia', avatars: {}, uploads: { Law: 'data:mafia' }, characters: ['Law', 'Bepo'], hiddenCharacters: [] };
    const { api, read } = boot({ ct_profiles_v1: { mafia: profile }, ct_cardmap_v2: { 'card:Law.png': 'mafia' } });
    assert.equal(api.getActiveProfileId(), 'mafia');
    assert.deepEqual(read('ct_profiles_v1').mafia, profile);
});

test('removing a character affects only the selected set', () => {
    const { api, context } = boot();
    const first = api.getActiveProfileId();
    api.rememberCharacters(['Law', 'Bepo']);
    api.setUploadedAvatar('Bepo', 'data:first');
    context.characterId = 1;
    api.rememberCharacters(['Bepo']);
    api.setUploadedAvatar('Bepo', 'data:second');
    api.removeCharacter('Bepo', first);
    assert.equal(api.resolveAvatarSrc('Bepo'), 'data:second');
    assert.equal(api.getActiveProfile().characters.includes('Bepo'), true);
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
    assert.equal(api.resolveAvatarSrc('Law'), 'https://example.test/extensions/thoughts/Medicine%20AU/%D0%9B%D0%BE%20%231.png');
    assert.equal(api.resolveAvatarSources('Law')[1], 'https://example.test/extensions/thoughts/avatars/Medicine%20AU/%D0%9B%D0%BE%20%231.png');
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
    assert.equal(api.getActiveProfileId(), null);
});

test('no open card does not create or bind a phantom default profile', () => {
    const { api, context, read } = boot({});
    context.characterId = undefined;
    assert.equal(api.getActiveProfileId(), null);
    api.rememberChatCharacters();
    assert.equal(read('ct_profiles_v1'), null);
});

test('opening and switching unbound cards and groups never creates sets', () => {
    const { api, context, read } = boot({});
    for (let n = 0; n < 5; n++) {
        context.characterId = n % 2;
        api.handleChatChanged();
        api.getActiveProfile();
        api.updateFromText('<char_thoughts>Bepo: here</char_thoughts>');
        assert.equal(api.getActiveProfileId(), null);
    }
    context.groupId = 42;
    api.handleChatChanged();
    assert.equal(read('ct_profiles_v1'), null);
    assert.equal(read('ct_cardmap_v2'), null);
    api.ensureProfile('chosen', 'Chosen');
    api.setActiveProfileId('chosen');
    api.rememberChatCharacters();
    assert.deepEqual([...api.getActiveProfile().characters], ['Bepo']);
});
