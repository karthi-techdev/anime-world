Japan Street Modular Pack Lite: Narrow Alley
============================================

The free Lite edition of Japan Street Modular Pack: Low Poly Town: one hand-dressed Japanese back alley, the narrow house type it is built from and the street kit around it.

Formats
-------
- FBX/, glTF/ (.gltf + .bin), OBJ/ (.obj + .mtl): one file per mesh, 372 meshes, 106,136 triangles. Metres;
  FBX and glTF are Y-up, OBJ Z-up as exported by Blender. Pivots sit at the lot corner or the foot of the piece.
- Blender/: JapanStreetModularPackLite.blend. Built with Blender 5.2; open with Blender 5.2 or newer.
- Textures/: the shared colour atlas, metallic-roughness atlas, signage sheets and their emission maps. Every format
  points at ../Textures/, so keep Textures/ next to the format folder. Edit one PNG and every format follows.

Materials
---------
- M_Pack02_Atlas: colour atlas + metallic-roughness atlas, most of the kit
- M_Pack02_Signage: a text sheet for signs, vending machines, posters and road paint
- M_Pack02_Signage2: a text sheet for signs, vending machines, posters and road paint

Atlas and MR textures should use nearest / Point filtering: the palette is flat swatches and bilinear filtering bleeds
neighbouring colours across swatch edges. Signage sheets use bilinear.

Assembled prefabs and sample streets
------------------------------------
Assembly/PF_<type>.json lists every assembled prefab (22 in 2 types) as parts: mesh name, position
(x, y, z) and rotation around the vertical axis (rot_z, radians), in Blender axes (Z-up), relative to the prefab
pivot at the lot corner. Assembly/<street>_layout.json places prefabs and props for AlleyScene.
In Blender the same prefabs are ready as collections:
- Open Blender/JapanStreetModularPackLite.blend: scene AlleyScene is the sample street, scene Overview shows every prefab,
  scene Assets holds the meshes and prefab collections.
- Or add the Blender/ folder as an asset library (Preferences > File Paths > Asset Libraries) and drag meshes or
  prefabs from the Asset Browser into any file; catalogs follow mesh groups and house types.

Licence
-------
Use in personal and commercial projects, no royalty and no attribution required. Redistributing the asset files
themselves is not allowed. Full terms in LICENSE.txt.

Third-party notices
-------------------
Text on the signage sheets is rasterized from Noto Sans JP, Shippori Mincho, Zen Maru Gothic, Yuji Syuku, Dela Gothic One, Mochiy Pop One (SIL Open Font License 1.1). Font files are not included. See
Third-Party Notices.txt.
