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
character-thoughts/
└── avatars/
    ├── polar-tang/        <- one folder per AU/profile
    │   ├── law.png
    │   └── bepo.png
    └── medieval/
        └── law.png
```

- Open the panel → ⚙ (settings). Pick or create a **profile**, set its **folder** name, then map each character to a filename (e.g. `law.png`).
- A profile is bound to a chat automatically based on the SillyTavern card name, so a new card creates a new profile on its own. Use the profile dropdown to switch manually.
- If no file is mapped (or the file is missing), the character shows a coloured initial circle instead.

## Storage

Everything is stored in browser `localStorage`:

| Key | Holds | Lifecycle |
| --- | --- | --- |
| `ct_thoughts_v1::<chatId>` | parsed thoughts/mood for that chat | resets per chat; "Clear" wipes the current chat |
| `ct_profiles_v1` | profiles: name, folder, name→file map | persists across chats |
| `ct_chatmap_v1` | which profile each chat uses | persists |

## Buttons

- **Parse last** — re-parse the most recent message (useful after an edit or swipe).
- **Clear** — wipe captured thoughts for the current chat only.

## Known limitations

- Names must match between `char_mood` and `char_thoughts`; if the model writes `Law` in one and `Trafalgar Law` in the other, they show as two cards.
- A thought that literally contains `; shortword:` may be misread as a new character (rare).
- If the model forgets a character's `Name:`, that fragment attaches to the previous character rather than spawning a junk entry — it self-corrects on the next turn that includes the name.

## License

MIT.
