# Map Recorder: user guide

Map Recorder helps you find walking paths missing from OpenStreetMap (OSM) and keep a reviewed collection of your own paths. It accepts GPX and GeoJSON recordings, including tracks exported from Organic Maps. **The results are proposals for you to check:** phone GPS can drift, and nearby lines do not always represent the same real path.

In the deployed app, choose **How to use** above the tabs to open the on-screen version of this guide.

## What the software does and why

| Feature | Purpose |
| --- | --- |
| Keeps separate track parts and recording times | A pause or lost GPS signal should not become a straight path nobody walked. |
| Finds likely GPS tangles | Repeated zigzags in a small area are isolated and flagged so you can leave them out. The correct route cannot be reconstructed from bad GPS alone. |
| Compares the walk with OSM roads | Parts already near mapped roads are set aside. Road Buffer controls the distance used. |
| Compares proposals with the Master Map | Repeated parts are set aside; genuinely new extensions remain. A shorter or denser recording cannot replace an approved path. |
| Shows the original and set-aside parts | You can inspect each decision on the map before saving. |
| Requires your approval | Only pieces you check enter the master or approved export. |

“Removed” means **excluded from the new-path proposal**. Your original file is not changed or deleted.

## Before starting

Keep the original recording from Organic Maps. It may contain timestamps that explain a strange line. Do not rely only on an earlier Delta export.

If you already have a Master Map, open **Master Map** and choose **Export Clean Master** to download a backup. The master is kept in this browser's local storage; it does not automatically appear on another device.

You may choose **Skip GPS** when reviewing an existing file. GPS permission is needed for the live **Recorder**, not for inspecting an uploaded walk.

## Review a walk

1. Open **Delta** and choose **Load Track (GPX / GeoJSON)**. Select your original walk. You need internet access for the OSM lookup. Delta sends the walk's map area to OSM lookup servers; the recording stays on your device.
2. Leave **Road Buffer** at **4.5 m** and **Min Length** at **3 m** for the first pass. Choose **Extract**.
3. Keep the map visible with the **Map/Controls** toggle. The review panel can be reduced while you inspect the map; reopening it keeps your choices.
4. Open **Map layers** to read the legend and turn individual layers on or off. Layer switches change only what you see; they do not approve or reject a path.
5. Open **Removed or skipped pieces** to see what the program set aside and why. Choose **Show** beside one of those pieces to center it on the map. Compare it with the gray original walk and the underlying OSM map. This is how you check whether a road or duplicate decision was right.
6. Choose **Show** beside one proposed new path. The map centers on it. Check that it really exists, is walkable, and lies in the right place. Pay extra attention to an amber GPS warning.
7. Tick the checkbox only for a path you accept. Leave doubtful ones unchecked. Repeat **Show** for each proposal you want to inspect.
8. Choose **Save Approved** to add checked pieces to the browser's Master Map. Choose **Approved GeoJSON** to download the checked pieces for your other map project. You can do both. **Clear** clears the current review without deleting the saved master.

The **Recorder** tab can capture a walk in the browser. After stopping, **Review for Master** sends it through the same Delta review. **Review Past GeoJSON** in Master Map does the same for an older file.

## Read the map

| Map layer | Meaning |
| --- | --- |
| **Original walk** (gray) | The recorded line, separated at known gaps. |
| **On OSM** (blue) | Recorded portions set aside because they fall near mapped roads. |
| **In Master** (purple) | Recorded portions set aside because they match paths you already approved. |
| **New path** (orange) | Pieces proposed for your review. Orange does not mean automatically approved. |
| **Check GPS** (amber) | A proposed piece near a pause, jump, or tangle that needs especially careful checking. |
| **Tiny skipped** (dashed gray) | Short fragments excluded either by Min Length or by the Master's fixed 3 m minimum. The selected piece gives the reason. |
| **Gaps / tangles** (markers) | Missing observations or an uncertain tangle boundary. No walked line is claimed across a split. |

When you use **Show** in either list, that piece is emphasized and the map moves to it. A bridge, gate, wall, or building can make two lines look connected on a map even when they are not connected on the ground.

## Adjust a questionable decision

**Road Buffer** is the distance around an OSM road that counts as mapped. A larger value sets aside more of your walk, including some real parallel paths. A smaller value leaves more proposals, including some GPS drift beside mapped roads. Change the number and run **Extract** again if the comparison looks wrong. The buffer is a tolerance, not proof that a path is new.

**Min Length** hides very short leftovers after the OSM comparison. A short connector could be real; lower this value and extract again when you are looking for one. A tiny fragment left after Master comparison has a fixed 3 m minimum, so this setting will not bring it back. A **Check GPS** warning means you should inspect the original recording and, if needed, walk the place again. The software splits long pauses and isolates tangles, but it cannot know the true route through bad observations.

If the OSM lookup fails, extraction stops instead of calling the whole walk new. Try again when the connection works.

## Your old master and backups

Paths saved before these review checks are not automatically corrected. The earlier tangled path may still be in your current master. Export a backup, clear the old master, then process the **original recordings** again through Delta. Opening an old master file through **Review Past GeoJSON** treats its lines as proposals, not as already corrected paths.

**Clear Master** deletes the paths stored in this browser after confirmation. **Export Clean Master** downloads a backup; keep it somewhere you control, especially before changing devices or clearing browser data.

Map Recorder produces a reviewed path overlay. Your navigation app will also need checked junctions, building entrances, and a connected walking network before it can calculate routes.

## Developer check

From this directory, run: node --test tests/*.test.js. The tests cover recording gaps, OSM filtering, repeat walks, extensions, incomplete OSM responses, and storage failures. The supplied Organic Maps timing checks run when that local source file is present; set MAP_RECORDER_SAMPLE_TRACK to its path if you move it.
