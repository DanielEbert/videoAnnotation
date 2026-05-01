# VideoAnnotation

### Developer Notes

- add usability: keybindings for everything like delete selected annotation. and in UI show the keybindings (e.g. delete button shows "delete (del)" or something like that)

- undo and redo for annotations (store complete state). store the last X transitions (high number)

- can we use a library for the pointInPolygon checks? this will only make sense if the library can significantly simplify other parts of the code too, so present a plan first. its also okay so say its not worth an extra library for this
