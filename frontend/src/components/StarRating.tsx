type Props = {
  rating: number;
  max?: number;
};

export function StarRating({ rating, max = 5 }: Props) {
  return (
    <span className="star-dots" aria-label={`${rating} of ${max} stars`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`star-dots__dot${i < rating ? " filled" : ""}`} />
      ))}
    </span>
  );
}
