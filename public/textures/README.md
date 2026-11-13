# Texturas do terreno

Texturas PBR locais, todas em 2K JPG e sob licença **CC0 1.0**:

- `ground_albedo.jpg`, `ground_normal.jpg` e `ground_roughness.jpg`: **Grass006** — https://ambientcg.com/view?id=Grass006
- `road_albedo.jpg`, `road_normal.jpg`, `road_roughness.jpg` e `road_ao.jpg`: **Ground030** — https://ambientcg.com/view?id=Ground030
- `tank_metal_albedo.jpg`, `tank_metal_normal.jpg`, `tank_metal_roughness.jpg` e `tank_metal_metalness.jpg`: **Metal006** — https://ambientcg.com/view?id=Metal006
- `suburban_field_01_1k.hdr`: **Suburban Field 01** — https://polyhaven.com/a/suburban_field_01

O terreno usa cor, normal e rugosidade; a estrada usa cor, normal, rugosidade e oclusão ambiente; partes metálicas dos tanques usam cor, normal, rugosidade e metalness; o HDRI ilumina os reflexos metálicos. As fontes são CC0 1.0 Universal. O jogo mantém texturas procedurais de reserva quando um mapa ainda está carregando.

O projeto carrega esses arquivos localmente. Se não estiverem disponíveis, usa a textura procedural de reserva.
