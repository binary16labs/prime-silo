# The drive registry

Every drive this machine has ever had attached, **by identity, never by letter**.

A backup drive takes the next free letter, so a registry keyed by letter showed drive B at G: the
facts of drive A — and S26 learnt the same lesson again when a catalogue resolved by recorded
_name_ served one disk's figures for another. A row here belongs to what a drive **is**.

**The registry lives on the machine**, at `BENNY_HOME/estate/drives.db`. F: comes and goes, and a
registry on F: would be absent exactly when the owner asks which drives they have.

## Identity

|         |                                                                                                                                                                                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | volume serial plus root file ID — **byte-identical to S21's**, because every catalogue is named `library-<identity>.db` and a different spelling would orphan every catalogue that exists |
| Linux   | the filesystem UUID, prefixed `uuid:`. The device number S21 uses changes across reboots and USB ports: the same disk, a second name, a second catalogue of the same files                |

A drive whose identity cannot be read is **attached, identity unknown**, and is never merged into
another row. Guessing which drive an unreadable root belongs to is how one disk's facts end up
under another's name.

## What the registry says, and what it refuses to say

It reports **what the operating system returned**. A field the call did not give is `null`, and the
panel shows it as "unknown" — a capacity inferred from a sibling field is indistinguishable from a
real one on screen, which is worse than a gap the owner can see. Where the OS omits capacity or
free space, `statfs` is asked; that is still measured.

The medium comes from the **disk's** bus (`usb`, `internal`, `network`), which is why the Windows
read is one call joining `Get-Volume` to `Get-Partition` and `Get-Disk`. A hotpluggable disk on an
unrecognised bus is treated as removable, because removable is the half that matters; an
unrecognised bus with no hotplug flag stays unknown.

A **volume label is the owner's own text**, and so is a display name they type through
`PATCH /api/estate/drives/:id`. Both are judged by the same quarantine rules the library uses, and
a match reads `label withheld` — counted, never named. The label is never written into the KEL
either: a tamper-evident log is the last place to put something just refused to the screen.

## What may be catalogued

**A system drive is never offered whole.** On Windows the registry marks the drive holding
`%SystemRoot%` and offers its **user roots** instead: Downloads first, then Documents, Desktop,
Pictures, Videos, Music and the OneDrive root. Those come from
`HKCU\...\Explorer\User Shell Folders`, which **follows redirection** — a guessed
`C:\Users\<name>\Documents` is wrong on this machine, where Documents, Desktop and Pictures live in
OneDrive. Each root is recorded against the drive it is really on.

`Windows`, `Program Files`, `Program Files (x86)`, `ProgramData` and `AppData` are never user roots
and cannot be added: they are not the owner's data, and AppData holds application caches and
credential stores nobody chose to hand over. The owner may add another folder with
`PATCH /api/estate/drives/:id { "add_user_root": … }`, recorded as their choice.

A drive without Windows is a **data drive** and is offered whole.

## Attached, stale, catalogued

The watch job compares what is attached with the registry every `ESTATE_DRIVE_WATCH_SECONDS`
(default 60) and writes **one event per change, not per tick** — a drive that has sat there all
week produces silence. A drive unseen for longer than `ESTATE_COPY_FRESH_DAYS` (default 30) reads
**stale**; an attached drive never does, because it is right here.

The catalogue column reads S21's last finished pass and **starts nothing**. For an attached drive it
is exact. For a **detached** one it reads `catalogue_unknown` rather than "never catalogued": the
only exported way to find a catalogue takes a root, and rebuilding the filename from an identity
here would be a second spelling of S21's naming rule. Telling the owner that a drive they have
catalogued never was is worse than admitting it cannot be read from here.

`retired_at` is reserved for U9 and is always null.

## Routes

`GET /api/estate/drives` · `PATCH /api/estate/drives/:id` — **loopback only**, like the library. A
label is the owner's text and a user root names where their documents live, which is not something
to serve to a LAN the hub binds `0.0.0.0` on. `403` off-machine · `412` with no quarantine policy ·
`400` an unknown identity or neither field · `409` a folder that may not be a user root · `503`
with no home to keep the registry in.
