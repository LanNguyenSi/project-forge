.PHONY: deploy logs restart pull

deploy:
	git pull
	docker compose up -d --build

logs:
	docker compose logs -f --tail=100

restart:
	docker compose restart

pull:
	git pull && docker compose up -d
