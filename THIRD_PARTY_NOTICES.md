# Third-party notices

The root [MIT license](LICENSE) covers this project's own code. It does not
replace the licenses of dependencies or third-party assets.

## HeadAudio and TalkingHead

- `@met4citizen/headaudio` 0.1.0: MIT, copyright 2025 Mika Suominen.
  The bundled `public/vendor/headaudio/headworklet.mjs` and
  `public/vendor/headaudio/model-en-mixed.bin` retain the upstream notice at
  [public/vendor/headaudio/LICENSE](public/vendor/headaudio/LICENSE).
  [Upstream](https://github.com/met4citizen/HeadAudio).
- `@met4citizen/talkinghead` 1.7.0: MIT; its copyright and license are distributed
  with the installed package. [Upstream](https://github.com/met4citizen/TalkingHead).

## Ready Player Me avatar

`public/models/master-avatar-rigged.glb` and
`assets/avatar/master-avatar-source.glb` (also embedded in the working scene
`assets/avatar/master-avatar.blend`) derive from the `brunette.glb` example
created with Ready Player Me and distributed by met4citizen/TalkingHead.
The local manifest records the source; the runtime copy was renamed and
packaged with project-specific manifest metadata.

The upstream README identifies this example asset as **CC BY-NC 4.0**.
Attribution: Ready Player Me; example distributed by Mika Suominen / met4citizen.
[Source](https://github.com/met4citizen/TalkingHead/blob/main/avatars/brunette.glb),
[upstream attribution](https://github.com/met4citizen/TalkingHead#credits),
[license terms](https://creativecommons.org/licenses/by-nc/4.0/).

This avatar is an exception to the project's MIT license: the bundled example
does not grant commercial-use rights. Replace it with an appropriately licensed
avatar before distributing a commercial product, or obtain the relevant rights
from the asset provider. Do not label this third-party asset as MIT licensed.

Other dependencies retain their own license files in their installed packages.
