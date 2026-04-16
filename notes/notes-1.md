Yes — and several of them are well worth knowing about, because they sharpen what Chromavox actually is and isn't.

## The closest historical analog: ANS Synthesizer (Murzin, 1958)

The single closest precedent. A Russian photoelectronic instrument where you draw on a glass plate with black mastic; light shines through to a row of photocells, each tuned to a frequency. Erasing mastic at vertical position y and horizontal position x produces a sine of pitch f(y) at time t(x). Eduard Artemyev used it for Solaris and Stalker.

The mapping is almost exactly Chromavox's:

- vertical position = pitch
- "blocking light" = silence in that band
- additive sine bank for resynthesis
- visual editing of the spectral mask is the interface

Chromavox is essentially "ANS where the mask isn't a flat plate but a 2D refractive scene that can route, disperse, and bend light between input and output rows." That's actually a non-trivial extension nobody has done in this exact form.

## Image-to-sound graphical synths (direct descendants of ANS)

These all share the "vertical = pitch, brightness = amplitude" mapping:

- Metasynth (U&I Software, 1998–) — paint a picture, get a sound. Stereo via RGB. The most polished modern version of the idea. Used heavily by Aphex Twin (the famous spectrogram face in Windowlicker).
- Photosounder — similar, more focused on bidirectional sound↔image conversion.
- Coagula (Rasmus Ekman) — free, lightweight image-to-sound.
- Virtual ANS (Alexander Zolotov) — direct ANS emulator, runs in a browser. Worth playing with for direct comparison.

These are offline tools. Chromavox is the real-time, physics-routed version of the same underlying idea.

## Vocoders proper

Worth distinguishing because the term gets used loosely:

- Channel vocoder (Dudley, Bell Labs 1939): split a modulator signal into N bands, use each band's envelope to gain-control the same band of a separate carrier. Hardware classics: EMS 5000, Roland SVC-350, Moog 16-channel. This is two-input by design: voice + synth → robot voice.
- Phase vocoder (Flanagan/Golden 1966): FFT-based, used for time stretching and pitch shifting. Single-input. Modern STFT resynthesis tools like Paul's Extreme Sound Stretch are descendants.
- Self-vocoder (modulator = carrier): bandpass the input by itself. Effectively a low-resolution spectral envelope follower applied to the source. This is the closest behavioral analog to what unobstructed Chromavox does — and it's never sold as a standalone product because it sounds, well, exactly like Chromavox does: a lossy spectral approximation that hints at the input but isn't it.

If you want to hear what unobstructed Chromavox is doing, set up any vocoder with input routed to both modulator and carrier and 16 bands. That's your reference sound.

## Sinusoidal additive resynthesis tools

Chromavox's output stage (fixed-pitch sine bank with amplitude envelopes per partial) is textbook sinusoidal modeling:

- McAulay–Quatieri model (1986) — analyze input as a sum of slowly-varying sinusoids; resynthesize.
- SPEAR (Klingbeil) — interactive sinusoidal partial editor. You can see the partials as horizontal lines and edit them.
- IRCAM AudioSculpt / SuperVP — high-end version of the same.
- Loris (CNMAT) — open-source partial-tracking library.

The difference: those analyze moving partials (with frequency interpolation between frames). Chromavox uses fixed partials (each voice's pitch never changes). This is why glissandi sound like crossfades rather than glides.

## Optical sound (the deep history)

Chromavox is in the lineage of drawn-sound on film:

- Variophone (Avraamov, 1930) — cut spinning paper discs whose silhouettes are read by a light beam onto film soundtrack.
- Oramics (Daphne Oram, 1957) — paint waveforms on 35mm film strips; photocells read them.
- Norman McLaren — hand-drew soundtracks directly onto film at NFB Canada.

All share Chromavox's foundational mechanic: light passes through a 2D scene and the result becomes audio. Chromavox adds physically-correct refraction to the scene, which is genuinely novel — none of the historical instruments modeled the light transport, they all just used straight-line occlusion or direct photocell readout.

## Spatial-routing instruments

For the "input position routes through a manipulable medium to output position" specifically:

- Reactable — tangible synth where physical pucks on a surface route audio between modules. Different physics (object adjacency, not optics) but same "edit the routing topology by moving physical things" feel.
- Buchla 200e Source of Uncertainty / Random Voltages — patches whose internal routing is non-obvious. Different domain.
- Modular synthesis broadly — patch cables as routing. Chromavox's optical elements are essentially patch cables that bend continuously.

## What makes Chromavox distinct

Lining these up, Chromavox sits at a specific intersection that I don't think any single existing instrument occupies:

- Real-time (vs. Metasynth/Coagula offline image-to-sound).
- Physically-modeled routing (vs. ANS / drawn-sound where the mask is just opacity).
- Wavelength-dependent routing (a prism actually fans out spectrum across sensors — that's a frequency-to-position transform that no other instrument in this list does optically).
- Editable optical scene (vs. fixed photocell array).
- Single-input self-vocoder topology (which you've identified as the audio limitation — but it's also what makes "drop a prism in and watch the sound smear across pitches" possible).

The closest single descriptor: "interactive ANS synthesizer with refractive optics." That's a real and interesting thing. The vocoder-style audio fidelity loss isn't a bug to apologize for — it's the medium. Metasynth, ANS, and Oramics all sound like themselves, not like a recording, and that's what makes them worth using rather than just running an audio cable.

## Practical implication

Going "vocoder style" intentionally means you're in the ANS / Metasynth tradition, not the audio-effects-pedal tradition. The right framing for users is probably something like: "a 2D optical bench whose light field is your sound's spectrum — manipulate the optics to manipulate the sound." That sets the right expectation: you're not processing the audio, you're playing the bench, with audio as the input control surface.

If you ever want to lean further into this: let users place light sources whose intensity is driven by mic bands AND let them place light sources driven by other signals (a slow LFO, MIDI, a sequencer). That makes the instrument unmistakably an instrument rather than an effect, which is the niche it's actually best suited for.

---

*1 step*

> could a physical chromavox be built

*Resumed your cloud container*

*Refresh your repository*

*Started Claude Code*

---

Yes, absolutely — and across multiple scales. The interesting questions aren't whether but which scale and how to handle a few specific challenges. Let me work through it.

## What the components map to in the physical world

Most pieces are off-the-shelf:

| Sim | Physical |
| --- | --- |
| Emitters (column of light sources) | Vertical array of intensity-modulable broadband sources — white LEDs are the obvious choice, halogen for purer spectrum |
| Dielectric blocks/prisms | Stock BK7 or F2-flint prisms, lenses (Edmund Optics, Thorlabs, Surplus Shed) |
| Mirrors | First-surface mirrors |
| Silhouettes | Opaque cards / 3D-printed shapes |
| Sensor wall | Array of color sensors (e.g., AMS AS7341, 8 spectral channels) OR line-scan camera + diffraction grating OR webcam behind a frosted screen |
| Mic / speakers | Standard, plus a Pi/Teensy/laptop running the FFT and synth |
| The 2D bench itself | Optical breadboard with magnetic-base elements you can drag around |

The mic→FFT→PWM→LED chain is straightforward microcontroller work. The sensor→bin→additive synth chain runs on the same machine.

## The one genuinely hard problem: making rays visible

In simulation, every ray is drawn as a glowing line because the renderer chooses to. In reality, light traveling through clear air is invisible — you only see photons scattered toward your eye. Without solving this, your physical Chromavox is just "lights on the left, color sensors on the right, nothing visible in between." That destroys the whole experience.

The classic solutions:

- Theatrical haze (low-density fog machine on minimum). Standard for laser shows. Beams become visible volumes. Works in any darkened room. Downside: hazy, smells, requires a darkened space, fog drifts and disturbs visibility unevenly.
- Fluorescein in a water trough. The legendary undergraduate optics demo. A shallow tank of fluorescein-doped water makes any beam passing through it glow green. Constrains all your optics to be submerged or float on the surface, and the water's own n≈1.33 means your "glass" elements need n significantly greater (acrylic at 1.49 is the practical floor). Beautiful when it works.
- Dust + dark room + bright source. Cheap. Inconsistent. Particles drift.
- Scattering plate at floor level. Project the ray paths down onto a white surface just below the beam plane — what you see is the footprint, not the beam itself. Less dramatic but reliable.
- Skip ray visibility entirely. Show a real-time projection of the simulated rays on a screen behind the optical bench, while only the physical input/output (mic, sensors, audio, hand-placed elements) are real. Hybrid. Not as cool but eliminates the visibility problem.

If I were building this for any sort of live use, I'd plan around theatrical haze in a dim room. It's the only solution that scales from desktop to museum and gives the right look.

## Three realistic builds

### Build 1: Desktop teaching kit (~$500–$2k DIY)

Inspired by the PASCO ray box kits that already exist for optics education.

- 18″ × 24″ optical breadboard or a steel sheet with magnetic-base mounts
- 8 white LEDs in a vertical column at the left edge, each on its own PWM channel
- A handful of stock prisms, plano-convex lenses, first-surface mirrors with magnetic bases
- Right edge: 8 AS7341 color sensors arrayed vertically (one per emitter row) on a single I²C bus
- Teensy 4.x with audio shield: mic in, speaker out, runs the FFT analysis, drives LEDs, reads sensors, runs the additive synth
- Light haze in a darkened room for visible beams (or skip and rely on the painted bench surface to show beam footprints)

This is essentially "PASCO ray box + audio I/O." The optics half is solved; you're adding the audio loop. Real, buildable in a weekend by someone with embedded skills, hits the conceptual idea cleanly even if the audio output is necessarily lo-fi (8 voices).

### Build 2: Performance / installation piece (~$5k–$20k)

Scale up by 4–10×.

- 4ft × 8ft optical breadboard, dark room, persistent light haze
- 32–64 emitter column. White LEDs are still fine, but consider:
  - RGB+W+UV high-CRI LEDs for cleaner spectrum (white phosphor LEDs have a gap around 500nm that produces ugly dispersion; tuned multi-die LEDs disperse to a more rainbow-like spectrum)
  - or filtered halogen with mechanical shutters / Pockels cells if you can afford the complexity
- Larger, higher-quality stock optics — Edmund's Education-Grade series, prisms 2″ across so beams are visually wide
- Sensor wall: line-scan camera (e.g., Basler racer) behind a frosted glass strip, calibrated against a Bayer or grating decomposition for per-position spectrum at maybe 64 vertical positions × 16 wavelength bins
- Audio handled by a laptop running real-time additive resynthesis (SuperCollider, Max/MSP, or custom)
- Magnetic kinematic mounts so participants can pick up and place elements with one hand

This is a museum-grade interactive piece. The dramatic "place a prism, see a rainbow fan toward the sensors, hear the chord shift" moment lands in this build.

### Build 3: Concert instrument (~$10k+ depending on ambition)

For someone wanting to play this live.

- Smaller, denser optical bench (precision over scale)
- Supercontinuum laser source if budget allows (~$10–30k for a low-end one) — gives you a true broadband point source you can split into a column with a beam-shaping diffractive optic, and modulation bandwidth into the kHz. This is the only way to get "audio-rate optical modulation" rather than the slow envelope tracking that LEDs give.
- Otherwise: array of fiber-coupled LEDs with optical modulators (acousto-optic or electro-optic for serious bandwidth)
- All optics on quick-release magnetic kinematic bases for fast on-stage rearrangement
- Sensor wall feeding a dedicated DSP with low-latency additive synth
- The whole rig in a black-anodized travel case

The ANS Synthesizer was essentially this category in 1958 — a building-sized musical instrument. People came to a studio to play it. Your version would be more portable.

## What you don't have to build

The ANS already exists (one is preserved at Glinka Museum, Moscow). PASCO ray boxes already exist. Optical sound-on-film exists historically (Oramics, Variophone). What's new in a physical Chromavox:

- The audio-driven emitter modulation, turning a passive teaching demo into a real-time instrument.
- The wavelength-aware sensor wall, turning the optics output into a polyphonic timbral signal rather than just per-position intensity.
- The user-rearrangeable scene, making it editable rather than fixed-installation like ANS.

Each of those three is the engineering content of the project. The optics, audio I/O, and signal flow are all 1950s technology you can buy off the shelf today.

## The actual hard parts, ranked

1. Beam visibility in a way that survives reasonable lighting — requires haze or hybrid solutions, constrains environment.
2. White light spectral quality — phosphor LEDs disperse weirdly. Multi-die or filtered halogen fixes it. Adds cost.
3. Sensor wall fidelity — cheap RGB sensors give you 3–8 channels per position, which is less spectral resolution than the simulation. A line-scan camera with a grating gets you to hundreds, but adds calibration work.
4. Drag-and-drop element handling that's also precise — magnetic kinematic mounts solve this but they cost ~$50–200 each and you need a lot of them.
5. Latency budget — mic → FFT → LED PWM → optical transit (instantaneous) → sensor integration → synth. Want <50ms total. The integration time on cheap color sensors is the typical bottleneck (~10–50ms each at low light). Brighter sources let you sample faster.

None of these is a research problem. They're all engineering tradeoffs.

## My honest take

A desktop build is genuinely worthwhile and could be done as a proof-of-concept in a few weekends by someone with optics + embedded comfort. It would be educational and weirdly delightful even with crude audio fidelity.

A museum installation is the form factor where this idea actually shines — the visible beams, the participatory element placement, the audio response, all benefit from scale and dim-room theatrics. ANS-style cultural cachet plausibly attainable.

A performance instrument is where the cost curve gets steep (real broadband sources, fast modulation) but where you'd unlock things the simulation can't easily do — true continuous spectrum, true continuous spatial position, the irreducible physicality of "I moved the prism three millimeters and the chord shifted."

The simulation is, in a real sense, the design tool for the physical version. You're already prototyping the instrument — every preset in docs/presets/ is a candidate scene for the physical bench. That's a nice property to have.

---

*1 step*

> if i go the simulation path with a display what could i use for objects correctly sensing location and rotation when positioned on screen

*Resumed your cloud container*

*Refresh your repository*

*Started Claude Code*

---

Several solid approaches, ranging from "weekend DIY" to "proven commercial precedent." The right pick depends on rotation accuracy, how many unique object types you need, and whether you want it to look like an integrated surface or you can tolerate visible cameras/markers.

## The five real options

### 1. Reactivision / TUIO (the proven precedent)

This is exactly the problem Reactable solved in 2005, and it's the closest thing to a turnkey answer for "tangible objects on a tabletop instrument."

How it works:

- Rear-projection table: projector throws image up onto a frosted glass top from inside a cabinet
- IR illuminators inside the cabinet shine up through the glass
- IR camera inside, looking up, sees the bottoms of objects placed on the glass
- Each object has a printed fiducial marker (amoeba-shaped, designed for occlusion robustness) glued to its bottom
- The Reactivision software (open source, free, ~20 years of development) tracks position + rotation + ID of every fiducial in real time
- Output is the TUIO protocol — a UDP stream of {id, x, y, angle} tuples

Why it's the right answer for Chromavox:

- Reactable solved literally the same problem: a tangible musical instrument on a tabletop where physical objects route signals
- Hundreds of unique IDs (the fiducial space is large)
- Pose accuracy easily ~1mm position, ~1° rotation
- Multi-object, no upper limit beyond camera resolution
- Robust to occlusion (fingers don't break tracking)
- TUIO clients exist for every language; trivial to consume in JS via a small WebSocket bridge

Cost: a few hundred dollars in projector + cabinet + camera + IR LEDs if you build it yourself, plus an afternoon assembling the box. Reactable cabinets are well-documented online.

Downsides: it's a cabinet, not a flat thin display. ~50–80 cm tall enclosure.

If you want the "play it like an instrument" feel, this is the path I'd take. It's the most boring recommendation and also the most correct one.

### 2. Capacitive marker tokens on a touchscreen

The modern thin-display alternative. Print/3D-print object bases with conductive feet in unique patterns (typically 3 feet per token). The touchscreen sees the feet as three simultaneous touches; the geometry encodes the object ID and the angle.

Examples in the wild:

- Microsoft's discontinued PixelSense / SUR40 — the gold standard for this, killed in 2018
- LogiTags and similar commercial offerings for Microsoft Surface Hub
- Various academic prototypes; "tangible markers" or "capacitive tokens"
- Apple's iPad supports this poorly — most iPads are limited to ~10 simultaneous touches, which caps you at ~3 tokens

Display options today:

- Microsoft Surface Hub 2S (~$9k) — supports many simultaneous touches and has some tangible-object SDK support
- Large commercial touch tables from Ideum, Multitouch, Sharp — purpose-built for this, $5–30k
- Industrial PCAP touchscreens from companies like GreenTouch, Zytronic — bare panels you integrate into your own enclosure, support 40+ simultaneous touches

Pros: thin form factor, looks like "a magic display," objects can be small and elegant.

Cons:

- Rotation accuracy is touch-resolution-limited — typically ~5° at best, which is worse than you want for precise prism orientation
- Limited number of distinct IDs per token size (the foot pattern has to fit on the token base)
- Most consumer touchscreens can't handle enough simultaneous touches for many objects at once
- Touch panels' palm rejection logic often fights you

Verdict: cleaner aesthetics, worse pose accuracy. Workable if you can live with ~5° rotation precision and a small object count, and if you can spend on a high-end touch panel.

### 3. Top-down camera + AprilTag/ArUco markers on object tops

Cheapest, lowest-effort starting point.

- Lay your display flat (any LCD, TV, or projector onto a table)
- Mount a camera on an arm overhead (or against a wall looking down)
- Stick AprilTag or ArUco fiducial markers on the top of each object
- Use OpenCV (or AprilTag's reference C library, or apriltag-js via WASM) to detect markers and extract {id, x, y, rotation} per frame at 30+ Hz
- Calibrate camera-to-display transform once (homography from 4 corner markers)

Pros:

- Minimum custom hardware: any display + any USB camera
- Pose accuracy is excellent (sub-pixel marker corner detection): <1mm and <0.5° easily
- Hundreds of unique IDs
- Works with any underlying display tech (cheap monitor, TV, even a projector on a regular table)

Cons:

- Camera mounted above is visually intrusive and constrains environment
- Markers are visible from above — they look like little black-and-white squares on top of your "lenses" and "prisms," which breaks the illusion
- Sensitive to lighting (overhead lights washing out the camera, hands shadowing the markers, etc.)
- Hands occlude markers when you're moving an object — tracker briefly loses lock

Best fit for: prototyping, demo videos, "I want to test the concept this weekend." Probably the wrong final form but the right first form.

### 4. Top-down depth camera (no markers needed)

Variant of (3) using a depth camera (Intel RealSense, Azure Kinect, OAK-D) instead of an RGB camera + markers.

- Each object is identified by its 3D shape (a prism is wedge-shaped, a lens has a curved profile, a mirror is thin and tall)
- Use ICP / shape matching against a known library
- Get pose for free from the depth registration

Pros: no visible markers — objects can look like real optical elements
Cons: shape-recognition robustness is hard (ambiguous orientations on rotationally symmetric objects, occlusion by hands), depth cameras still have visible mounting

This is more research-y than the others but gives the cleanest aesthetic. Worth considering if "objects look like the thing they represent" matters to you.

### 5. Hybrid: capacitive position + active electronic ID

Each object has a microcontroller (ESP32, Seeed XIAO) that broadcasts its ID over BLE. The touchscreen detects where it is (via 1–2 capacitive touch points). The BLE side tells you what it is. Compass / IMU in the object reports rotation.

Pros: clean look (no fiducials), accurate rotation (IMU), accurate ID (no foot-pattern decoding ambiguity)
Cons: every object needs a battery, charging, electronics — high per-object cost and maintenance burden. You'd need to recharge a dozen prisms regularly.

Not recommended unless you're committed to this as a polished product.

## My recommendation, short version

For the canonical Chromavox tabletop instrument: build a Reactivision-based reactable cabinet. It is exactly the problem you are solving, the open-source software is mature, the tracking is robust enough to play live, and the visual aesthetic (light from below glowing through frosted glass while you place tangible objects on top) is honestly perfect for a light-routing instrument. The fact that Reactable was a celebrated audio-visual instrument doing essentially the same UI you need is more than coincidence — it's a strong signal that this approach fits.

If you want a cleaner thin-display look and can compromise on rotation accuracy: large touchscreen + capacitive marker tokens. Best with high-end industrial touch panels that support 40+ simultaneous touches.

For a quick prototype before committing: flat monitor + overhead RGB camera + AprilTag markers. You'll have working object tracking in an afternoon. Use it to validate the gameplay/musicality before building anything custom.

## A few Chromavox-specific gotchas to think about

- Rotation matters a lot. A prism rotated by 5° produces a visibly different dispersion pattern. A mirror rotated by 5° sends light to a totally different sensor. Whichever sensing approach you pick, measure its actual rotation jitter before building around it. Touchscreen-token approaches often have noisy rotation estimates from frame to frame; you'll want a low-pass filter and possibly snap-to-angle for ergonomics.
- Object footprint vs. element size. Your simulation prisms are a few cm across. If your physical token is 8cm across (typical for capacitive tangibles or fiducial visibility), the touched footprint is much larger than the displayed element, which feels wrong. Either scale the simulation up or design tokens with a small base + a clear visual indicator of the element shape.
- Stacking and occlusion. What if a user puts a "lens" on top of a "block"? Most tracking systems can't see the lower one. Decide whether your instrument allows stacking and design accordingly.
- Coordinate calibration drift. All optical and capacitive systems need periodic re-calibration. Build a one-button "place these four corner tokens on the four red dots" recalibration flow from day one.

---

*1 step*

> i want objects to be fully transparent, no markers

*Resumed your cloud container*

*Refresh your repository*

*Started Claude Code*

---

This is a much harder constraint, but it's solvable — and the answer turns out to be the same architecture as Reactivision (rear-projection cabinet with IR camera below) but with shape-based recognition instead of fiducial markers. Transparent objects on a glass surface are not actually invisible to a properly-set-up tracking rig; they're just invisible to the naked eye. Here's why and how.

## Key insight: transparent objects still leave optical signatures

A clear glass prism sitting on a glass surface produces several detectable signals:

- Its footprint changes the optical contact at the surface. Where the object presses against the glass, the air gap is replaced by glass-on-glass (or glass-on-acrylic) optical coupling. IR light propagates differently there.
- The bottom face scatters IR back toward an under-screen camera. Even highly polished glass scatters some light at any interface; a slightly frosted or sandblasted base surface makes this near-100% reliable while still looking transparent to the eye.
- The dielectric constant differs from air (glass ε ≈ 5–7, air ε = 1). This is detectable by capacitive sensing.
- Mass concentrates pressure at the contact area. Detectable by pressure mats.
- Above the surface, a glass object refracts the displayed image in a characteristic way. Detectable by an overhead camera looking at how the shown pattern is warped.

You only need one of these signals to do the job. The cleanest is #2.

## The recommended architecture: Diffuse Illumination (DI) tabletop

This is the standard tabletop-computing rig, well-documented since ~2007 by the NUI Group community.

Build:

- A cabinet (~50–80 cm tall) with a glass or acrylic top
- Projector inside, throwing the display image onto the glass from below (rear-projection) — or use a flat-panel LCD with IR-transparent backing if you want the cabinet shorter
- IR illuminators (850 nm or 940 nm LED strips) inside the cabinet, illuminating the underside of the glass from below at a shallow angle
- IR camera (any USB camera with the IR-cut filter removed; ~$30 modified, or buy a no-IR-cut machine vision cam) inside the cabinet, looking up at the glass through an IR bandpass filter (so the projected image doesn't blind it)
- A diffuser layer between the projector and the glass surface (frosted PET film or rear-projection screen material)

What the IR camera sees: mostly black (the diffuser scatters IR uniformly when nothing's there). When you place an object on the top surface, its bottom face appears as a bright silhouette because:

- The object pushes the diffuser into optical contact with the glass
- IR light couples into the object's bottom and scatters back toward the camera

This is the same mechanism that Reactable, Microsoft Surface 1.0, and many DIY multi-touch tables used to detect fingers on the surface. It works equally well for transparent objects — better, in fact, because objects have larger and more characteristic contact areas than fingertips.

Software:

- OpenCV blob extraction on the IR camera frames (threshold, contour finding) — gives you a list of {contour, centroid} per frame
- Shape classification: each blob's contour is matched against a known set (triangle = prism, square = block, line = mirror, rabbit-shape = rabbit, etc.) via Hu moments, contour matching, or a small CNN
- Rotation extraction: the contour's principal axis (PCA on the contour points, or the angle of the minimum-area bounding rectangle) gives you orientation modulo symmetry
- Tracking: simple Kalman / Hungarian assignment between frames to maintain stable IDs as objects move
- Output: TUIO {id, x, y, angle} per object, just like the marker-based Reactivision pipeline

The whole computer-vision side is ~200–400 lines using OpenCV, runs at 60+ FPS on any modern CPU. CCV (Community Core Vision) is an existing open-source framework that does exactly this — built by the tabletop computing community for years.

For your object designs:

- Cast or 3D-print clear resin (or use stock glass optics with custom bases)
- Lightly frost the bottom face (sandblast, etched film, or a layer of clear-but-microtextured polymer) — invisible to the user looking at the side, but provides a uniform, bright IR return
- Make each base shape distinctive enough to classify reliably:
  - Prism → triangle
  - Block → square
  - Mirror → narrow strip (significantly different aspect ratio than block)
  - Convex lens → small circle
  - Concave lens → annulus (donut, since the optical center is thinner than the rim)
  - Rabbit → rabbit
- Avoid two element types with the same base shape — the system can't tell them apart from a footprint alone

This works. Reliably. The object on top can be made of pristine polished optical glass with no markers, no electronics, no batteries, and no visible alteration. From above, your scene looks like a real optical bench. From the camera's perspective below, every object is a clean labeled shape.

## Other approaches and why they're worse for this constraint

### Frustrated TIR (FTIR)

Variant: IR LEDs injected into the edge of an acrylic top sheet. Light is trapped by TIR. Touching the top frustrates TIR locally and IR escapes down to a camera. Works great for fingertips, less great for glass-on-glass because the optical impedance match at glass-glass is too good — you don't get the same brightness pop. Stick with DI for transparent objects.

### Pressure-sensitive surface (Sensel Morph or DIY FSR matrix)

A thin force-sensor mat under the display detects mass distribution. Pros: thin, no cabinet, works with any LCD on top. Cons: spatial resolution is limited (Sensel is ~1.4 mm), large mats are custom and pricy ($1k+), pressure footprints don't always uniquely identify objects (many different shapes can produce similar pressure maps), rotation accuracy depends on how distinctive the base footprint is.

Use case: if you absolutely need the slim-display form factor and can't accept a rear-projection cabinet. Otherwise, IR is better.

### Overhead camera with refraction analysis

Camera mounted above the display looking down. The display shows a known pattern (a fine grid or a sequence of structured-light frames). A transparent object on top refracts the displayed pattern below it. The camera sees the warped pattern and can solve for the object's position and rotation by matching warp signatures.

This is genuinely cool and would let you keep a flat-display form factor with no cabinet — but the math gets complex, robustness under hand occlusion is tricky, and you're dependent on continuously displaying calibration patterns (which limits how the screen can be used for the actual simulation visualization).

I'd file this under "research project, not weekend build."

### Capacitive dielectric mapping

Modern PCAP touchscreen controllers can in principle expose raw capacitance maps that show any dielectric load — including non-conductive glass — not just fingertip touches. If you can find a controller that exposes raw mutual-capacitance frames (most don't; it's locked behind firmware), you could detect glass shape by the capacitance silhouette.

This is theoretically elegant — same display, no camera, no cabinet, fully passive transparent objects — but I don't know of a commercial controller that exposes the raw data with high enough resolution. Custom electronics territory.

### Embedded passive electromagnetic resonators (tuned LC circles)

A small loop of wire + capacitor inside the object, sealed in resin so it's invisible. An antenna grid under the screen excites a sweep and detects the resonance frequency — different objects have different resonance frequencies. Rotation can be derived from anisotropic coil orientation, or by combining with a touchscreen's positional read. This is how Wacom's stylus position works.

Pro: completely invisible in transparent resin. Con: requires custom electronics; "embedded resonator" is arguably a hidden marker, depending on how strictly you read your "no markers" rule.

## My honest recommendation

Build the rear-projection table with diffuse IR illumination and OpenCV shape recognition. Specifically:

- ~60cm tall cabinet with a glass top and a short-throw projector inside
- IR LED strips at ~30° angle illuminating the underside of the glass, plus a diffuser sandwich between projector and glass
- A modified webcam (IR-cut filter removed) inside the cabinet with an 850nm bandpass filter, looking up at the glass
- CCV or your own OpenCV pipeline doing blob extraction → shape classification → orientation → TUIO output
- Web-Chromavox client receiving TUIO via a small WebSocket bridge, mapping each tracked object's {id, x, y, angle} to a scene element

Cost: ~$300–600 if you're frugal. Build time: a long weekend if you've done electronics, a week or two if not.

The objects themselves can be gorgeous — polished glass or cast clear resin with lightly frosted bases, completely indistinguishable from real optical components when held in your hand. That's the experience you're after.

The aesthetic payoff is real: you place a real glass prism on a glowing tabletop, the simulated rays fan out into a rainbow on the display below, the chord shifts in the speakers. Nothing on the prism but glass. That's the instrument worth building.

## A few practical notes

- Hand rejection: your IR camera will see hands too. Filter by blob size and shape — fingertips are small ovals, your objects are larger and have distinctive contours. CCV has this built in.
- Stacking: if a user stacks objects, the lower one's footprint is unchanged but the upper one is invisible (camera can't see through the lower). Decide whether to allow stacking; if not, detect stacking events and warn the user.
- Calibration: you need a one-time camera→display homography. Show four corner crosshairs, ask the user to tap them, compute the transform. Periodic recalibration as the rig settles.
- Lens objects with rotational symmetry have no detectable rotation from shape alone, which is fine because their optical behavior is also rotationally symmetric — the simulation doesn't need to know their angle.
- Concave-lens annulus footprint is real: the bottom face is concave, so only the rim contacts the surface. The IR camera sees a ring, which is actually a nice, distinctive shape for the classifier.
