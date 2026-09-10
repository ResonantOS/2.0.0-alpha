// Intent citation: docs/architecture/ADR-018-addon-sdk-v0.md

import type {
  AddOnDockIconName,
  AddOnInstallation,
  AddOnManifest,
  Capability,
  ShellSectionId,
} from "../../../src/core/contracts";

export interface AddOnSurfaceDockRoute {
  addonId: string;
  surfaceId: string;
  sectionId: ShellSectionId;
  label: string;
  eyebrow: string;
  dockIcon: AddOnDockIconName;
  order: number;
}

const hasGrantedCapability = (installation: AddOnInstallation, capability: Capability): boolean =>
  installation.grantedCapabilities.some((grant) => grant.capability === capability && grant.granted);

export const createAddOnSurfaceDockRoutes = (
  manifests: AddOnManifest[],
  installations: Record<string, AddOnInstallation>,
): AddOnSurfaceDockRoute[] =>
  manifests
    .flatMap((manifest) => {
      const installation = installations[manifest.id];
      if (!installation?.installed || !installation.enabled) {
        return [];
      }

      return manifest.surfaces.flatMap((surface): AddOnSurfaceDockRoute[] => {
        const navigation = surface.shellNavigation;
        if (!navigation) {
          return [];
        }
        const missingCapability = (navigation.requiredCapabilities ?? []).find(
          (capability) => !hasGrantedCapability(installation, capability),
        );
        if (missingCapability) {
          return [];
        }

        return [
          {
            addonId: manifest.id,
            surfaceId: surface.id,
            sectionId: navigation.sectionId,
            label: surface.label || manifest.name,
            eyebrow: navigation.eyebrow,
            dockIcon: navigation.dockIcon,
            order: navigation.order ?? 1000,
          },
        ];
      });
    })
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
