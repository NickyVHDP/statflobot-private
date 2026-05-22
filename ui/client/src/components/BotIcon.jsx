export default function BotIcon({ size = 48, className = '', style = {} }) {
  return (
    <img
      src="/logo-icon.png"
      alt="StatfloBot"
      className={className}
      style={{ width: size, height: size, objectFit: 'contain', ...style }}
    />
  );
}
