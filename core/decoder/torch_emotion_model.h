#ifndef DECODER_TORCH_EMOTION_MODEL_H_
#define DECODER_TORCH_EMOTION_MODEL_H_

#include <memory>
#include <string>
#include <vector>

#include "torch/script.h"
#ifndef IOS
#include "torch/torch.h"
#endif

#include "utils/log.h"
#include "utils/utils.h"

namespace wenet {

class TorchEmotionModel {
 public:
  using TorchModule = torch::jit::script::Module;

  TorchEmotionModel() = default;
  TorchEmotionModel(const TorchEmotionModel& other);
  void Read(const std::string& model_path);
  void Reset();

  void ForwardEmotionChunk(
      const std::vector<std::vector<float>>& chunk_feats,
      torch::Tensor* chunk_out_accumulator = nullptr,
      torch::Tensor* inter_accumulator = nullptr);

  torch::Tensor ForwardEmotionHead();

  int subsampling_rate() const { return subsampling_rate_; }
  int right_context() const { return right_context_; }
  int num_emotions() const { return num_emotions_; }

  void set_chunk_size(int s) { chunk_size_ = s; }
  void set_num_left_chunks(int n) { num_left_chunks_ = n; }

 private:
  std::shared_ptr<TorchModule> model_ = nullptr;

  // Encoder streaming state
  torch::Tensor att_cache_ = torch::zeros({0, 0, 0, 0});
  torch::Tensor cnn_cache_ = torch::zeros({0, 0, 0, 0});
  int offset_ = 0;

  // Emotion accumulation buffers
  std::vector<torch::Tensor> final_outs_;
  std::vector<torch::Tensor> inter_outs_;

  int subsampling_rate_ = 4;
  int right_context_ = 6;
  int chunk_size_ = 16;
  int num_left_chunks_ = -1;
  int num_emotions_ = 2; // For Stress and Stability

  std::vector<std::vector<float>> cached_feature_;
};

}  // namespace wenet

#endif  // DECODER_TORCH_EMOTION_MODEL_H_
