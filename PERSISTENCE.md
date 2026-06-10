# User Data Persistence

The web build persists user data by phone number. The page URL keeps the same
contract:

```text
https://px.ks.santisaas.com/?phone=1598220xxxx
```

When `CLOUD_STORAGE_DRIVER=local` (the Docker Compose default), state data is
stored in the project directory under:

```text
./data/cloud-storage
```

When `CLOUD_STORAGE_DRIVER=postgres`, state data is stored in PostgreSQL under
keys like:

```text
users/{phone}/santi-project-store
users/{phone}/_p/{projectId}/director
users/{phone}/opencut-api-config
```

Generated and uploaded media is stored separately from the project JSON. With
the Docker Compose default `CLOUD_MEDIA_DRIVER=local`, media bytes are stored in
the project directory under:

```text
./data/cloud-media
```

If `CLOUD_MEDIA_DRIVER=oss` is configured, generated and uploaded media is stored
in Aliyun OSS under:

```text
mj/users/{phone}/...
```

Generation task snapshots are stored under:

```text
./data/generation-tasks
```

## Local Development

Create `.env` from `.env.example`, then start the local PostgreSQL container:

```bash
npm run db:up
npm run dev:web
```

Or run both with:

```bash
npm run dev:web:persistent
```

Docker downloads the `postgres:16-alpine` image automatically if it is not
available locally.

The PostgreSQL container is exposed on host `127.0.0.1:15432` by default for
local tools. The app container still connects internally to `postgres:5432`.
Set `POSTGRES_HOST_PORT` in `.env` only if you need a different host port.

## Server Deployment

Use Docker Compose:

```bash
docker compose up -d --build
```

The compose file starts both services:

- `postgres`: local PostgreSQL database with a persistent Docker volume.
- `moyin-creator`: web app on port `8088`.

The app service bind-mounts these project-local directories so rebuilds and
container recreation do not delete generated media:

```text
./data/cloud-storage
./data/cloud-media
./data/generation-tasks
```

Keep OSS keys and database passwords in `.env`. Do not commit `.env` or `data/`.
