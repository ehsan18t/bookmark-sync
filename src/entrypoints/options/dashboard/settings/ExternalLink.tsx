import { Icon } from '../../../../ui/components/Icon.js';

interface ExternalLinkProps {
  href: string;
  label: string;
}

export function ExternalLink({ href, label }: ExternalLinkProps) {
  return (
    <a href={href} target="_blank" rel="noopener" class="btn">
      {label}
      <Icon name="external-link" />
    </a>
  );
}
