# Character Thoughts

A SillyTavern UI extension that shows each character's current **thoughts** and **mood**, parsed from the `<char_thoughts>` and `<char_mood>` info blocks in the latest message. Thoughts are kept per chat; avatars are organised into per-AU profiles. The panel follows your active SillyTavern theme.

> Companion to [Relationship Memory Tracker](https://github.com/Wanichka/sillytavern-relationship-memory-tracker) — same look and feel.

---

## What it does

- Reads the `<char_thoughts>` / `<char_mood>` blocks the model writes each turn and lays them out as cards: an avatar, the character's name, a mood subtitle, and the thought rendered as an italic inner-voice quote.
- Stores the captured state **per chat**, so every chat starts clean and reopening a chat shows its last state.
- Lets you assign an avatar image per character, grouped into **profiles** (one profile per AU / card), so a brand-new card gets a fresh set and you never re-assign avatars when you start another chat in the same AU.
- Falls back to a coloured initial circle whenever a character has no avatar yet, so the panel never looks broken.

## Requirements

- A reasonably recent SillyTavern (extensions API with `getContext()`).
- A prompt/preset that makes the model output the info blocks below.

## Installation

**Via the UI (recommended):** Extensions → *Install Extension* → paste this repo's git URL.

**Manual:** copy the `character-thoughts` folder into:

```
SillyTavern/public/scripts/extensions/third-party/character-thoughts/
```

Then reload SillyTavern. A **Thoughts** button appears near the bottom-right.

## Expected info-block format

The extension does not generate thoughts — it parses what the model already writes. Add something like this to your system prompt / info block so each reply ends with:

```
<char_mood>
Mood = Name1: short mood ; Name2: short mood
</char_mood>
<char_thoughts>
Thoughts = Name1: *first-person inner monologue* ; Name2: *first-person inner monologue*
</char_thoughts>
```

Parsing rules:

- Characters are separated by `;` **only when** the `;` is followed by a `Name:`. A `;` inside a sentence stays part of the current thought, so a single multi-clause monologue is not split into a phantom character.
- Surrounding `*italics*` markers are stripped for display.
- A character that appears in `char_thoughts` but not `char_mood` (or vice-versa) still shows up; the missing half is just left blank.

## Avatars & profiles

Avatars are plain image files you drop in by hand. They live under the extension folder, grouped by profile:

```
sillytavern-character-thoughts/
├── index.js
├── medicine-au/          <- one folder per AU/profile
│   ├── law.png
│   └── bepo.png
└── medieval-au/
    └── law.png
```

- Open the panel → ⚙ (settings). Pick an **Avatar set** or create one with **＋**. Use **✎** to rename it. The main screen shows only the set selector and the saved character list.
- A profile is bound to the **card file**, so two cards named “Law” keep separate settings. All chats of one card share its selected profile. Groups have their own bindings. Use the profile dropdown to choose a different set; the choice is remembered for that card.
- For a disk image, click **📁** beside the character. Enter the folder name and exact image filename when prompted. Folder spelling and case are preserved. The folder applies to the entire set; the filename applies to this character. Cancelling either prompt saves nothing. Choosing a file replaces this character's uploaded image. For a per-user installation at `SillyTavern/data/default-user/extensions/sillytavern-character-thoughts/`, enter `medicine-au` for its `medicine-au/` subfolder. The folder must already exist. The older `avatars/<folder>/<file>` layout is tried if the direct file fails to load. If both exist, the direct folder wins. Paths are relative to the loaded extension, supporting public and per-user installations.
- Alternatively, **Upload** picks and crops an image. Uploaded images are saved in this browser, not written into the disk folder, and take priority over file mappings. The **✕** button clears the uploaded image so the folder file is used again.
- Settings retain all characters found in thoughts/moods, including those in the history of a chat when you open it and those with previously saved avatars. The thoughts panel still shows the latest captured thoughts only.
- **Names** beside a character lets one avatar respond to several names. For example, give `Трафальгар Ло` the names `Ло, Трафальгар, Trafalgar Law`. Matching ignores letter case and repeated spaces; the displayed thought name stays exactly as written by the model. Names apply only to the selected avatar set. If another character in that set already owns an avatar or name mapping, the extension refuses a conflicting name. Editing Names to an empty value clears the list. Removing the main character also removes its alternate names.
- **🗑** beside a character removes them from this profile's settings and clears their avatar assignments without changing messages or disk files. They remain hidden even if they appear again; **Restore removed characters** brings the names back, but does not restore cleared avatars. Names must match the spelling in the thoughts/mood blocks.
- If no file is mapped (or the file is missing), the character shows a coloured initial circle instead.

### Upgrading to 1.3.3

Existing sets, images, rosters and card bindings are retained unchanged. New/unbound cards show **Choose an avatar set…**; opening cards, switching chats and receiving thoughts never create a set automatically. Select an existing set or explicitly create one with **＋**. Old name-based profiles are not copied automatically. If earlier versions created unwanted sets such as “Law (2)”, you can delete them manually; deletion leaves the card awaiting selection and does not recreate the set, even when deleting the last set. If 1.3.0 copied unwanted characters into a set, remove them individually with **🗑**; this update does not clean up any existing characters. Selecting the same set for multiple cards explicitly shares its avatars and roster. Creating a set with an already-used name asks for a different name instead of silently binding to someone else's set.

Bindings use the card's avatar filename. Replacing or renaming that file outside the extension may require selecting its profile again.

## Storage

Everything is stored in browser `localStorage`:

| Key | Holds | Lifecycle |
| --- | --- | --- |
| `ct_thoughts_v1::<chatId>` | parsed thoughts/mood for that chat | separate per chat |
| `ct_profiles_v1` | profile name, folder, file mappings, uploads, saved and hidden character names, alternate names | persists across chats |
| `ct_cardmap_v2` | card filename/group ID → profile | persists |
| `ct_cardmap_v1` | old name-based bindings | left untouched; no longer used for automatic copying |

## Buttons

- **⟳** — re-parse the most recent assistant message (useful after an edit or swipe).
- **⚙** — configure the current card's profile, folder and saved characters.

## Development checks

Run `node --test tests/storage.test.cjs` (Node.js 18+). Tests cover duplicate card names, migration, switching, persistent rosters, removal, folder URLs, and delayed avatar uploads.

## Known limitations

- Names must match between `char_mood` and `char_thoughts`; if the model writes `Law` in one and `Trafalgar Law` in the other, they show as two cards.
- A thought that literally contains `; shortword:` may be misread as a new character (rare).
- If the model forgets a character's `Name:`, that fragment attaches to the previous character rather than spawning a junk entry — it self-corrects on the next turn that includes the name.

## License

MIT.
