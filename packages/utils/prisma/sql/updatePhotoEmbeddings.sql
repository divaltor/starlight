UPDATE photos 
SET 
    tag_vec = $3::vector,
    image_vec = $4::vector
WHERE id = $1 AND user_id = $2;
