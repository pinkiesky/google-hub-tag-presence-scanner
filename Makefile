.PHONY: prettify lint-mother lint-rpi lint-mock lint-esp32 \
	format-mother format-rpi format-mock format-esp32

prettify:
	+$(MAKE) -j4 --output-sync=target lint-mother lint-rpi lint-mock lint-esp32
	+$(MAKE) -j4 --output-sync=target format-mother format-rpi format-mock format-esp32

lint-mother:
	npm --prefix cat-presence-mother run lint:fix

lint-rpi:
	npm --prefix cat-presence-satellite-rpi run lint:fix

lint-mock:
	npm --prefix cat-presence-satellite-mock run lint:fix

lint-esp32:
	$(MAKE) -C cat-presence-satellite-esp32 lint

format-mother:
	npm --prefix cat-presence-mother run format

format-rpi:
	npm --prefix cat-presence-satellite-rpi run format

format-mock:
	npm --prefix cat-presence-satellite-mock run format

format-esp32:
	$(MAKE) -C cat-presence-satellite-esp32 format
