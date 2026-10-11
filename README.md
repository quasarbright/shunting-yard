# Shunting Yard

A train shunting puzzle game. Only the locomotive moves anything: drag it to
drive, pull levers to throw switches, click between cars to couple them, and
get every lettered car to its marker.

## Running it

```bash
node server.mjs 8981
```

Then open http://localhost:8981 for the game and http://localhost:8981/editor.html
for the level editor. The server serves the folder with no caching and lets
the editor save levels. On GitHub Pages the game runs as a static page; the
editor needs the server.

## Levels

Each level is a file in `levels/`, named after its title (`Hand-off` is
`hand-off.level.json`; saving under a new title renames the file); the format
is described at the top of `grid.mjs`. `levels/order.json` lists the levels in the game, in
order. Anything else in `levels/` is a draft. The editor's Levels button opens
levels, makes new ones, and moves them in and out of the game.

## Code

- `grid.mjs`: a level's track on the grid, worked out into nodes and track shapes
- `yard.mjs`: track geometry and how tracks connect
- `motion.mjs`: the rules: driving, pushing, coupling, switches, turntables, plates
- `setup.mjs`: a level file into a yard and a starting position, and what's wrong with it
- `game.mjs`: the game on a canvas, used by `index.html` and the editor's Play mode
- `editor.mjs`: the level editor
- `solve.mjs`: a search over the real engine, for checking levels can be finished

```bash
node --test            # geometry, engine and level files
SLOW=1 node --test     # also solve every level
```
