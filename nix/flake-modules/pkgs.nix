{ inputs, ... }:
{
  perSystem =
    { system, ... }:
    {
      _module.args.pkgs = import inputs.nixpkgs {
        inherit system;
        overlays = [ (import ../overlays/bun-cve-2026-111497.nix) ];
      };
    };
}
