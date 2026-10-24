# Prebuilt container images

Every merge to `main` publishes ready-to-run images, so you can deploy without building from source.

## Images

| Image                                    | Source app    | What it runs          |
| ---------------------------------------- | ------------- | --------------------- |
| `ghcr.io/feedbouncer/feedbouncer-api`    | `apps/api`    | The API server        |
| `ghcr.io/feedbouncer/feedbouncer-worker` | `apps/worker` | The background worker |
| `ghcr.io/feedbouncer/feedbouncer-web`    | `apps/web`    | The web app           |

## Tags

- `latest`, and the full commit SHA of each merge to `main`.
- Each image has its own `latest`. After a failed build, one image can lag behind the others, so pin all three to the same SHA tag if you need a matched set.
- There are no release or version tags yet.

## Platforms

Each tag is a multi-platform image for `linux/amd64` and `linux/arm64`. To check:

```sh
docker buildx imagetools inspect ghcr.io/feedbouncer/feedbouncer-api:latest
```

## Pull

```sh
docker pull ghcr.io/feedbouncer/feedbouncer-api:latest
docker pull ghcr.io/feedbouncer/feedbouncer-api:<commit-sha>
```
