{ inputs, ... }:
{
  imports = [
    inputs.flake-root.flakeModule
    inputs.treefmt-nix.flakeModule
  ];
  perSystem =
    {
      config,
      pkgs,
      ...
    }:
    {
      treefmt.config = {
        inherit (config.flake-root) projectRootFile;
        package = pkgs.treefmt;
      };
      formatter = config.treefmt.build.wrapper;
      treefmt.config.programs = {
        ## Nix
        # format nix files
        nixfmt.enable = true;
        # remove unused nix variables (skip with `# deadnix: skip`)
        deadnix.enable = true;
        # highlight antipaterns in nix code
        statix.enable = true;
        ## Everything else
        oxfmt.enable = true;
      };
    };
}
