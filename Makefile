TESTING_PLUGINS := $(shell xcode-select -p)/usr/lib/swift/host/plugins/testing

.PHONY: help deps cert dev test typecheck build install update uninstall clean clean-computers e2e-computer e2e-tasks e2e-step4 e2e-step5 e2e-step6

help:
	@echo "make deps       install Node.js (brew) and npm packages"
	@echo "make cert       create the local signing identity (once)"
	@echo "make dev        run the daemon with auto-reload (board at http://127.0.0.1:47321)"
	@echo "make test       daemon tests + notch tests"
	@echo "make typecheck  TypeScript checks for daemon and board"
	@echo "make install    build Hive.app and install it to /Applications (also: make update)"
	@echo "make uninstall  remove the app (agents and data in ~/.hive stay)"
	@echo "make e2e-computer  isolation check for virtual computers (Docker + Claude Code login)"
	@echo "make e2e-tasks  tasks and agent-to-agent check with real Claude Code (a few cents)"
	@echo "make e2e-step4  wakes, budgets and pause check with real Claude Code (a few cents)"
	@echo "make e2e-step5  Architect hardening canary and proposal check with real Claude Code (a few cents)"
	@echo "make e2e-step6  templates and connectors check with fake gh and osascript (no cost, nothing real runs)"
	@echo "make clean-computers  remove every Hive virtual computer (containers, networks, volumes, images)"

deps:
	@command -v node >/dev/null || brew install node
	cd daemon && npm install
	cd web && npm install

cert:
	./scripts/create-cert.sh

dev:
	cd web && npm run build
	cd daemon && npm run dev

test:
	cd daemon && npm test
	cd notch && swift test -Xswiftc -plugin-path -Xswiftc $(TESTING_PLUGINS)

typecheck:
	cd daemon && npx tsc -p .
	cd web && npx tsc -p .

build:
	./scripts/build-app.sh

install: build
	./scripts/install-app.sh

update: install

uninstall:
	-osascript -e 'tell application id "local.hive.app" to quit'
	rm -rf /Applications/Hive.app

clean:
	rm -rf build notch/.build web/dist

clean-computers:
	-docker ps -aq --filter label=hive.agent | xargs docker rm -f
	-docker network ls -q --filter label=hive.agent | xargs docker network rm
	-docker volume ls -q --filter name=hive-home- | xargs docker volume rm
	-docker images -q 'hive/computer' | xargs docker rmi -f
	-docker images -q 'hive/netns' | xargs docker rmi -f

e2e-computer:
	scripts/e2e-computer.sh

e2e-tasks:
	scripts/e2e-tasks.sh

e2e-step4:
	scripts/e2e-step4.sh

e2e-step5:
	scripts/e2e-step5.sh

e2e-step6:
	cd daemon && home=$$(mktemp -d) && HIVE_HOME=$$home node --test test/e2eStep6.test.ts; status=$$?; rm -rf $$home; exit $$status
