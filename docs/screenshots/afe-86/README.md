# AFE-86 Ink design language

Real local browser → Fastify API → PostgreSQL with sample events, connections
and services. The GitHub Actions screens use mocked `/api/actions/github/*`
responses because the local instance has no linked GitHub account. Light and dark
at 1440px and 390px.

| Screen                                                                           | Light                                                                 | Dark                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Events                                                                           | [1440](events-light-1440.png) · [390](events-light-390.png)           | [1440](events-dark-1440.png) · [390](events-dark-390.png)           |
| Mapping: 8 services paged by 5, search, "Add service" form open (AFE-83, AFE-85) | [1440](mapping-light-1440.png) · [390](mapping-light-390.png)         | [1440](mapping-dark-1440.png) · [390](mapping-dark-390.png)         |
| GitHub Actions, repository picker open (AFE-85)                                  | [1440](github-light-1440.png) · [390](github-light-390.png)           | [1440](github-dark-1440.png) · [390](github-dark-390.png)           |
| Connections                                                                      | [1440](connections-light-1440.png) · [390](connections-light-390.png) | [1440](connections-dark-1440.png) · [390](connections-dark-390.png) |

Verified no horizontal overflow and no browser page errors on any of these views.
