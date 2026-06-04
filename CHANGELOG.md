# Changelog

## [0.3.1](https://github.com/chrischall/evite-mcp/compare/v0.3.0...v0.3.1) (2026-06-04)


### Bug Fixes

* adopt @fetchproxy/server 0.13.0 (bridge host failover + re-pairing) ([#22](https://github.com/chrischall/evite-mcp/issues/22)) ([b2ca0f9](https://github.com/chrischall/evite-mcp/commit/b2ca0f916bb87d48fe8e9298fa55d733b5a5ad9a))
* adopt @fetchproxy/server 1.0.0 + @chrischall/mcp-utils 0.5.0 ([#24](https://github.com/chrischall/evite-mcp/issues/24)) ([d2dc631](https://github.com/chrischall/evite-mcp/commit/d2dc6319f2eba904a8dcaedfca0fa5492029b8ef))

## [0.3.0](https://github.com/chrischall/evite-mcp/compare/v0.2.1...v0.3.0) (2026-06-02)


### Features

* evite_upload_photo — upload to an event's shared photo album ([#18](https://github.com/chrischall/evite-mcp/issues/18)) ([6f0784f](https://github.com/chrischall/evite-mcp/commit/6f0784fc9a25ca84700987fe7524cff535708856))


### Performance

* stream photo upload from disk instead of buffering the whole file ([#20](https://github.com/chrischall/evite-mcp/issues/20)) ([8304037](https://github.com/chrischall/evite-mcp/commit/8304037533e29503f96daccb88c7243f92681147))

## [0.2.1](https://github.com/chrischall/evite-mcp/compare/v0.2.0...v0.2.1) (2026-06-01)


### Bug Fixes

* tier-1 login was missing CSRF priming (cold POST 403s) ([#16](https://github.com/chrischall/evite-mcp/issues/16)) ([f534642](https://github.com/chrischall/evite-mcp/commit/f534642f30b855bf80b46452f8f5191284905389))

## [0.2.0](https://github.com/chrischall/evite-mcp/compare/v0.1.0...v0.2.0) (2026-06-01)


### Features

* add the four remaining write tools (add_guest, send, cancel, reinstate) ([76ef72c](https://github.com/chrischall/evite-mcp/commit/76ef72c8cec0e1956663b44ed0fd78386e5b3791))
* confirm-gated Evite write tools + wire into index ([209c5ae](https://github.com/chrischall/evite-mcp/commit/209c5ae04ace84ae1c0212a566880ef7093d3ccb))
* evite read tools (events, guests, rsvp summary, messages) ([88221cd](https://github.com/chrischall/evite-mcp/commit/88221cdd0d98ed8f7d72de2801d147aea2b07b22))
* evite session resolution (cookie env + fetchproxy bootstrap) ([0e7f347](https://github.com/chrischall/evite-mcp/commit/0e7f3476291678ab638cde64630b80880009d300))
* evite_duplicate_event + document settings endpoint ([ca5d60f](https://github.com/chrischall/evite-mcp/commit/ca5d60f8561a609e91855a7f1b55e9d382cb1dc5))
* evite_duplicate_event + document settings endpoint ([fbae959](https://github.com/chrischall/evite-mcp/commit/fbae9594977c90c2c5a6266978521b44245cb167))
* evite_healthcheck tool + runMcp bootstrap ([702039c](https://github.com/chrischall/evite-mcp/commit/702039c5dbcc76a3d631fa935306868de3f2a6d3))
* evite_list_templates — discover template_name slugs for create_event ([8edfeda](https://github.com/chrischall/evite-mcp/commit/8edfedad495b11232f86a8e84bd0dd9ddd5370b9))
* evite_update_guest + evite_remove_guest (draft guest edit/remove) ([290acf7](https://github.com/chrischall/evite-mcp/commit/290acf72069a346a79ac702e88b894caceb98837))
* EviteClient over the internal /services API ([590d110](https://github.com/chrischall/evite-mcp/commit/590d110fd6cf698883a45161747ab35bcb4e55e0))
* EviteClient write methods (rsvp, sendMessage, create/update event) ([abfd42a](https://github.com/chrischall/evite-mcp/commit/abfd42af989e01a59920549cb7cb623cefc299ac))
* refine CSRF header assumption to X-CSRFToken; record write-capture blocker ([888075c](https://github.com/chrischall/evite-mcp/commit/888075c5d8de0a3da17ac755ce9e6aa577376ef7))
* tier-1 email/password login via POST /ajax_login ([4a135ce](https://github.com/chrischall/evite-mcp/commit/4a135cea84f570f7694a588dba3ca1ef46af6ae2))
* verify createEvent + updateEvent (plain /services/, {event:{}} envelope) ([26d994c](https://github.com/chrischall/evite-mcp/commit/26d994ce96b6fb1b99ba87553bd59aba87883ae4))
* verify RSVP (PUT) + add reinstateEvent; nail add-guest body via live probe ([26caab5](https://github.com/chrischall/evite-mcp/commit/26caab5d86bcd400e7588bd77978479a0d6d6baa))
* verify the two broadcast writes — send-invitation + send-message (9/9) ([1a1400f](https://github.com/chrischall/evite-mcp/commit/1a1400f5a5be5ce34fd05e45742bd53dde7010f6))
* verify write convention (POST .../actions/{verb}/ → 202) + add cancelEvent ([8771e52](https://github.com/chrischall/evite-mcp/commit/8771e5259cec7e5ec39524f6d055e169038b4213))


### Bug Fixes

* bump src/auth.ts version marker in release-please extra-files ([#12](https://github.com/chrischall/evite-mcp/issues/12)) ([8c0c580](https://github.com/chrischall/evite-mcp/commit/8c0c580c88e0a98e0b7d8aee782bddfe4c018cc4))
* re-land evite_broadcast (lost in stacked merge) + address [#5](https://github.com/chrischall/evite-mcp/issues/5)/[#7](https://github.com/chrischall/evite-mcp/issues/7) review nits ([#10](https://github.com/chrischall/evite-mcp/issues/10)) ([0e79737](https://github.com/chrischall/evite-mcp/commit/0e797376279bafe5822bed8f748496902528e43e))


### Refactor

* drop stale 'UNVERIFIED' framing now that writes are verified; fix createEvent ([51ef6fe](https://github.com/chrischall/evite-mcp/commit/51ef6fe82f2f630446eb701ebf27f4b9cbd78375))


### Documentation

* capture second write API surface (/ajax/event/{id}/) from live create+send flow ([daf2012](https://github.com/chrischall/evite-mcp/commit/daf201203014fc410e51157ef5ea4c6cec505a07))
* capture tier-1 login flow (POST /ajax_login) ([7b3167f](https://github.com/chrischall/evite-mcp/commit/7b3167fa2debd79dd1d22f362358767a410c10da))
* complete Evite read-API discovery (all 5 read endpoints + shapes) ([ce1cc79](https://github.com/chrischall/evite-mcp/commit/ce1cc7938130c59cdcb55d83a31e758831415ddd))
* evite-mcp design spec ([253d7bf](https://github.com/chrischall/evite-mcp/commit/253d7bf0046de051315c098845365c5565a5ab76))
* evite-mcp Plan 1 — scaffold + discovery spike ([940ad64](https://github.com/chrischall/evite-mcp/commit/940ad6463083a62909c214718a87eefb0e2d5cf5))
* evite-mcp Plan 2 — auth (fetchproxy + cookie env) + 5 read tools ([a32dc4b](https://github.com/chrischall/evite-mcp/commit/a32dc4b165fc1e8eaccf68416cc8bdc314850665))
* list confirm-gated write tools (live payloads pending [#3](https://github.com/chrischall/evite-mcp/issues/3)) ([bf25e91](https://github.com/chrischall/evite-mcp/commit/bf25e91d9ff047a9783316af45ca546410e796fd))
* README (status, architecture, roadmap) ([5e99ae0](https://github.com/chrischall/evite-mcp/commit/5e99ae0b5dddf0357f19a93a3982fd2065c33bfa))
* real Evite API discovery from live spike (events-list + auth confirmed) ([a447398](https://github.com/chrischall/evite-mcp/commit/a4473984bc9e9c265b19ebd35f86dfea4483bed2))
* verify X-CSRFToken (+ token rotates) and reverse-engineer add-guest body shape ([77cf3a2](https://github.com/chrischall/evite-mcp/commit/77cf3a237f9966763b01eccf8215c991ff1aa51a))
