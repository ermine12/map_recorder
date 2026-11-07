#!/usr/bin/env python3
"""
Delta Extractor — GPX to Unmapped Shortcut GeoJSON
===================================================
Processes a raw GPX walking track (e.g., from Organic Maps) and strips out
any road segments that already exist on OpenStreetMap, leaving behind ONLY
the new, unmapped shortcuts.

5-Step Pipeline:
  A. Ingest GPX Track → Shapely LineString in UTM
  B. Fetch existing OSM roads within the track's bounding box
  C. Buffer OSM roads by a tolerance (default 4.5m)
  D. Compute spatial difference (walked track minus OSM roads)
  E. Clean fragments, reproject to WGS84, export GeoJSON

Usage:
  python delta_extractor.py --input walk_track.gpx --output clean_shortcut.geojson --buffer 4.5
"""

import argparse
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

import geopandas as gpd
import gpxpy
import osmnx as ox
from shapely.geometry import LineString, MultiLineString, mapping
from shapely.ops import linemerge, unary_union

# Suppress noisy warnings from geopandas/pyproj during CRS ops
warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning, module="pyproj")


# ============================================================
# Step A: Ingest GPX Track
# ============================================================
def ingest_gpx(gpx_path: str) -> gpd.GeoDataFrame:
    """
    Read a .gpx file, extract all track segments, and return a GeoDataFrame
    of LineString geometries in EPSG:4326 (WGS84).

    Handles multi-segment GPX files (pauses, multiple tracks) by creating
    one LineString per continuous segment.
    """
    gpx_file = Path(gpx_path)
    if not gpx_file.exists():
        print(f"[ERROR] GPX file not found: {gpx_file}")
        sys.exit(1)

    if gpx_file.suffix.lower() not in (".gpx", ".xml"):
        print(f"[ERROR] Expected a .gpx file, got: {gpx_file.suffix}")
        sys.exit(1)

    with open(gpx_file, "r", encoding="utf-8") as f:
        gpx = gpxpy.parse(f)

    segments = []

    for track in gpx.tracks:
        for segment in track.segments:
            coords = [
                (point.longitude, point.latitude)
                for point in segment.points
                if point.latitude is not None and point.longitude is not None
            ]
            # A valid LineString needs at least 2 points
            if len(coords) >= 2:
                segments.append(LineString(coords))

    if not segments:
        print("[ERROR] No valid track segments found in the GPX file.")
        print("        Ensure the file contains at least one <trkseg> with ≥2 points.")
        sys.exit(1)

    print(f"[Step A] Ingested {len(segments)} track segment(s) "
          f"with {sum(len(s.coords) for s in segments)} total points.")

    gdf = gpd.GeoDataFrame(geometry=segments, crs="EPSG:4326")
    return gdf


# ============================================================
# Step B: Fetch Existing OSM Roads
# ============================================================
def fetch_osm_roads(track_gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """
    Download all walkable OSM road geometries within the bounding box
    of the GPX track using osmnx.
    """
    # Compute bounding box from the track (in WGS84)
    total_bounds = track_gdf.total_bounds  # [minx, miny, maxx, maxy]
    west, south, east, north = total_bounds

    # Add a small padding (~50m) to the bbox to catch roads at edges
    pad = 0.0005  # ~55m at equator
    bbox = (north + pad, south - pad, east + pad, west - pad)

    print(f"[Step B] Fetching OSM roads within bbox: "
          f"N={bbox[0]:.5f} S={bbox[1]:.5f} E={bbox[2]:.5f} W={bbox[3]:.5f}")

    try:
        # Download walkable network
        G = ox.graph_from_bbox(bbox=bbox, network_type="walk")
        edges = ox.graph_to_gdfs(G, nodes=False, edges=True)

        if edges.empty:
            print("[WARNING] No OSM roads found in this area.")
            return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")

        # Keep only geometry column, ensure CRS
        roads = edges[["geometry"]].copy()
        roads = roads.to_crs("EPSG:4326")

        print(f"[Step B] Downloaded {len(roads)} OSM road segments.")
        return roads

    except Exception as e:
        print(f"[ERROR] Failed to download OSM data: {e}")
        print("        Check your internet connection and try again.")
        sys.exit(1)


# ============================================================
# Utility: Estimate UTM zone from WGS84 geometry
# ============================================================
def estimate_utm_crs(gdf: gpd.GeoDataFrame) -> str:
    """
    Estimate the best UTM CRS for a GeoDataFrame based on its centroid.
    Returns an EPSG code string like 'EPSG:32637'.
    """
    centroid = gdf.dissolve().centroid.iloc[0]
    lon, lat = centroid.x, centroid.y

    # UTM zone number
    zone_number = int((lon + 180) / 6) + 1

    # North or South hemisphere
    if lat >= 0:
        epsg = 32600 + zone_number
    else:
        epsg = 32700 + zone_number

    return f"EPSG:{epsg}"


# ============================================================
# Step C: Create Spatial Buffer (Tolerance Zone)
# ============================================================
def buffer_roads(
    roads_gdf: gpd.GeoDataFrame,
    utm_crs: str,
    buffer_meters: float,
) -> gpd.GeoDataFrame:
    """
    Buffer all OSM road geometries by the given distance (in meters).
    Operations are done in a projected CRS for metric accuracy.
    """
    if roads_gdf.empty:
        return roads_gdf

    # Reproject to UTM for metric buffering
    roads_utm = roads_gdf.to_crs(utm_crs)
    roads_utm["geometry"] = roads_utm.geometry.buffer(buffer_meters)

    print(f"[Step C] Buffered {len(roads_utm)} road segments by {buffer_meters}m.")
    return roads_utm


# ============================================================
# Step D: Compute Spatial Difference (Delta Extraction)
# ============================================================
def compute_delta(
    track_gdf: gpd.GeoDataFrame,
    buffered_roads: gpd.GeoDataFrame,
    utm_crs: str,
) -> gpd.GeoDataFrame:
    """
    Subtract the buffered OSM road footprints from the walked track.
    Returns a GeoDataFrame of the remaining 'new shortcut' geometries.
    """
    # Reproject track to UTM
    track_utm = track_gdf.to_crs(utm_crs)

    # Merge all track segments into a single geometry
    walked_line = unary_union(track_utm.geometry)

    if buffered_roads.empty:
        # No OSM roads found — the entire track is "new"
        print("[Step D] No OSM roads to subtract. Entire track is new.")
        delta_geom = walked_line
    else:
        # Merge all buffered road polygons into one
        road_footprint = unary_union(buffered_roads.geometry)

        # The delta: walked track minus known roads
        delta_geom = walked_line.difference(road_footprint)

    if delta_geom.is_empty:
        return gpd.GeoDataFrame(geometry=[], crs=utm_crs)

    # Normalize to a list of LineStrings
    lines = []
    if isinstance(delta_geom, (MultiLineString,)):
        lines = list(delta_geom.geoms)
    elif isinstance(delta_geom, LineString):
        lines = [delta_geom]
    else:
        # GeometryCollection or mixed types — extract only lines
        for geom in getattr(delta_geom, "geoms", [delta_geom]):
            if isinstance(geom, LineString):
                lines.append(geom)
            elif isinstance(geom, MultiLineString):
                lines.extend(geom.geoms)

    print(f"[Step D] Delta extraction produced {len(lines)} raw segment(s).")
    return gpd.GeoDataFrame(geometry=lines, crs=utm_crs)


# ============================================================
# Step E: Clean and Export
# ============================================================
def clean_and_export(
    delta_gdf: gpd.GeoDataFrame,
    output_path: str,
    min_length_meters: float = 3.0,
    buffer_meters: float = 4.5,
    input_file: str = "",
) -> None:
    """
    Filter tiny slivers, reproject to WGS84, and export as GeoJSON.
    """
    if delta_gdf.empty:
        print("\n" + "=" * 60)
        print("  ⚠  No new shortcuts found.")
        print("  The entire track overlaps with existing OSM roads.")
        print("=" * 60)
        return

    # Filter out fragments shorter than the minimum length
    delta_gdf = delta_gdf[delta_gdf.geometry.length >= min_length_meters].copy()

    if delta_gdf.empty:
        print("\n" + "=" * 60)
        print(f"  ⚠  No new shortcuts found after filtering (<{min_length_meters}m slivers removed).")
        print("  The entire track overlaps with existing OSM roads.")
        print("=" * 60)
        return

    # Try to merge nearby/connected segments
    merged = linemerge(unary_union(delta_gdf.geometry))
    if isinstance(merged, LineString):
        geoms = [merged]
    elif isinstance(merged, MultiLineString):
        geoms = list(merged.geoms)
    else:
        geoms = list(delta_gdf.geometry)

    # Filter merged segments again
    geoms = [g for g in geoms if g.length >= min_length_meters]

    if not geoms:
        print("\n" + "=" * 60)
        print(f"  ⚠  No new shortcuts found after merging and filtering.")
        print("=" * 60)
        return

    # Build final GeoDataFrame
    result = gpd.GeoDataFrame(geometry=geoms, crs=delta_gdf.crs)

    # Reproject back to WGS84 for GeoJSON export
    result = result.to_crs("EPSG:4326")

    # Add metadata properties
    now = datetime.now(timezone.utc).isoformat()
    input_name = Path(input_file).stem if input_file else "unknown"

    result["name"] = [
        f"shortcut-{input_name}-{i+1}" for i in range(len(result))
    ]
    result["source"] = "Organic Maps GPX + OSM Delta Extractor"
    result["created_at"] = now
    result["stroke"] = "#E51B23"
    result["stroke-width"] = 4
    result["stroke-opacity"] = 0.9
    result["buffer_meters"] = buffer_meters
    result["length_meters"] = result.to_crs(delta_gdf.crs).geometry.length.round(1)

    # Export
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    result.to_file(str(out_path), driver="GeoJSON")

    # Summary
    total_length = result["length_meters"].sum()
    print(f"\n[Step E] Export complete!")
    print(f"         Segments: {len(result)}")
    print(f"         Total new path length: {total_length:.1f}m")
    print(f"         Output: {out_path.resolve()}")
    print()

    # Print per-segment details
    for _, row in result.iterrows():
        print(f"  📍 {row['name']}: {row['length_meters']}m")

    print(f"\n  ✅  GeoJSON saved to: {out_path}")


# ============================================================
# Main CLI
# ============================================================
def main():
    parser = argparse.ArgumentParser(
        description=(
            "Delta Extractor — Strip existing OSM roads from a GPX walking "
            "track and export only the new unmapped shortcuts as GeoJSON."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python delta_extractor.py --input walk.gpx --output shortcut.geojson
  python delta_extractor.py --input walk.gpx --output shortcut.geojson --buffer 6.0
  python delta_extractor.py -i track.gpx -o result.geojson -b 3.0
        """,
    )

    parser.add_argument(
        "--input", "-i",
        required=True,
        help="Path to the input .gpx file (from Organic Maps, etc.)",
    )
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="Path for the output .geojson file (default: <input_stem>_shortcuts.geojson)",
    )
    parser.add_argument(
        "--buffer", "-b",
        type=float,
        default=4.5,
        help="Buffer distance around OSM roads in meters (default: 4.5)",
    )
    parser.add_argument(
        "--min-length",
        type=float,
        default=3.0,
        help="Minimum segment length in meters; shorter fragments are discarded (default: 3.0)",
    )

    args = parser.parse_args()

    # Default output name
    if args.output is None:
        args.output = str(Path(args.input).with_suffix("")) + "_shortcuts.geojson"

    print()
    print("=" * 60)
    print("  🗺️  Delta Extractor — GPX to Unmapped Shortcuts")
    print("=" * 60)
    print(f"  Input:       {args.input}")
    print(f"  Output:      {args.output}")
    print(f"  Road buffer: {args.buffer}m")
    print(f"  Min length:  {args.min_length}m")
    print("=" * 60)
    print()

    # Step A: Ingest GPX
    track_gdf = ingest_gpx(args.input)

    # Estimate the best UTM projection for this area
    utm_crs = estimate_utm_crs(track_gdf)
    print(f"[CRS]    Using projected CRS: {utm_crs}")

    # Step B: Fetch OSM roads
    roads_gdf = fetch_osm_roads(track_gdf)

    # Step C: Buffer OSM roads
    buffered_roads = buffer_roads(roads_gdf, utm_crs, args.buffer)

    # Step D: Compute spatial difference
    delta_gdf = compute_delta(track_gdf, buffered_roads, utm_crs)

    # Step E: Clean and export
    clean_and_export(
        delta_gdf,
        output_path=args.output,
        min_length_meters=args.min_length,
        buffer_meters=args.buffer,
        input_file=args.input,
    )


if __name__ == "__main__":
    main()
