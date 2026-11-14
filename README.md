# Map Recorder

Map Recorder turns recorded walks into **proposed** paths for a local map. It compares each continuous part of a GPX or GeoJSON recording with OpenStreetMap roads and then with the paths already saved in the browser. It keeps the original recording separate from the approved master layer.

## Review a walk

1. Keep the original Organic Maps GPX or GeoJSON file. Its timestamps are useful for detecting pauses and GPS noise.
2. Open the **Delta** tab and load the original recording. Choose **Extract** while online so the app can fetch the OSM roads for that area.
3. Inspect each proposed piece with **Show**. The review list flags long gaps and repeated movement in a small area. Only check pieces you recognize as real, walkable paths.
4. Choose **Save Approved** or **Approved GeoJSON**. Both use only checked pieces. Saving compares them against the master again, so a repeated walk cannot replace or shorten an existing approved path.

The Recorder's **Review for Master** button and the Master's **Review Past GeoJSON** control send their tracks through the same Delta review. Recorder exports now include a timestamp for each retained point and separate line features after long GPS gaps.

The master is stored in this browser's local storage. Export it regularly as a backup. Existing master paths saved before the review flow are not automatically repaired: export a backup, clear the old master, and review the original recordings again. This is especially relevant to the previously exported tangled path.

## What the filters do

- Split distinct source lines and long recording gaps instead of joining them with invented straight lines.
- Isolate and flag dense repeated movement in a small area. The software cannot determine the correct path through GPS noise by itself; such pieces require visual review.
- Remove the portions of a walk inside the chosen OSM road corridor, including when a sparsely sampled line crosses a mapped road between recorded points.
- Keep only portions outside the approved master paths. Previously saved geometry is never replaced by a denser or shorter walk.
- Reject incomplete OSM responses rather than treating a failed lookup as an empty map.

This produces a reviewed path overlay. A future navigation app still needs verified connections between these paths, OSM pedestrian paths, and building entrances. Proximity alone does not prove that two paths connect or are accessible.

## Checks

Run `node --test tests/*.test.js` from this directory. The tests include repeat-walk and extension cases, sparse OSM crossings, and, when the matching Organic Maps source file is present, the long recording's real timing gaps. Set `MAP_RECORDER_SAMPLE_TRACK` to the matching source file if it has been moved.
